import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useManualMode} from './useManualMode.ts';
import type {IJoystickUpdateEvent} from 'react-joystick-component/build/lib/Joystick';

describe('useManualMode', () => {
    let mowerAction: (action: string, params: Record<string, unknown>) => () => Promise<void>;
    let sendJsonMessage: (msg: unknown) => void;
    let startStream: (uri: string) => void;

    beforeEach(() => {
        mowerAction = vi.fn(() => vi.fn().mockResolvedValue(undefined));
        sendJsonMessage = vi.fn();
        startStream = vi.fn();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function renderManualMode() {
        return renderHook(() =>
            useManualMode({
                mowerAction,
                joyStream: {sendJsonMessage, start: startStream},
            })
        );
    }

    it('starts with manual mode off', () => {
        const {result} = renderManualMode();
        expect(result.current.manualMode).toBe(false);
    });

    it('activates manual mode without sending a client-side blade command', async () => {
        const {result} = renderManualMode();
        await act(async () => {
            await result.current.handleManualMode();
        });
        expect(mowerAction).toHaveBeenCalledTimes(1);
        expect(mowerAction).toHaveBeenCalledWith('high_level_control', {Command: 7});
        expect(result.current.manualMode).toBe(true);
    });

    it('stops in place, disables the blade, and deactivates manual mode', async () => {
        const {result} = renderManualMode();
        await act(async () => {
            await result.current.handleManualMode();
        });
        expect(result.current.manualMode).toBe(true);
        vi.mocked(mowerAction).mockClear();

        await act(async () => {
            await result.current.handleStopManualMode();
        });
        expect(mowerAction).toHaveBeenCalledTimes(2);
        expect(mowerAction).toHaveBeenNthCalledWith(1, 'high_level_control', {Command: 8});
        expect(mowerAction).toHaveBeenNthCalledWith(2, 'mow_enabled', {mow_enabled: 0, mow_direction: 0});
        expect(result.current.manualMode).toBe(false);
    });

    it('keeps manual mode latched through a short non-manual state blip', () => {
        const {result, rerender} = renderHook(
            ({stateName}: {stateName: string | undefined}) => useManualMode({
                mowerAction,
                joyStream: {sendJsonMessage, start: startStream},
                stateName,
            }),
            {initialProps: {stateName: 'MANUAL_MOWING'}},
        );
        expect(result.current.manualMode).toBe(true);

        rerender({stateName: 'IDLE'});
        act(() => { vi.advanceTimersByTime(1199); });
        expect(result.current.manualMode).toBe(true);

        act(() => { vi.advanceTimersByTime(1); });
        expect(result.current.manualMode).toBe(false);
    });

    it('handleJoyMove scales joystick input by MAX_LINEAR_MPS and MAX_ANGULAR_RAD_S', async () => {
        const {result} = renderManualMode();
        await act(async () => { await result.current.handleManualMode(); });
        const joystickEvent = {
            type: 'move',
            x: 0.5,
            y: 0.8,
            direction: null,
            distance: null,
        } satisfies IJoystickUpdateEvent;
        act(() => {
            result.current.handleJoyStart();
            result.current.handleJoyMove(joystickEvent);
        });
        // Raw joystick: x=0.5, y=0.8 → scaled to linear=0.8*0.25=0.2, angular=-0.5*0.6=-0.3
        expect(sendJsonMessage).toHaveBeenCalledWith({
            header: {stamp: {sec: 0, nanosec: 0}, frame_id: ""},
            twist: {linear: {x: 0.2, y: 0, z: 0}, angular: {z: -0.3, x: 0, y: 0}},
        }, false);
    });

    const ZERO_TWIST = {
        header: {stamp: {sec: 0, nanosec: 0}, frame_id: ""},
        twist: {linear: {x: 0, y: 0, z: 0}, angular: {z: 0, x: 0, y: 0}},
    };
    const joyEvent = (x: number, y: number) =>
        ({type: 'move', x, y, direction: null, distance: null}) satisfies IJoystickUpdateEvent;
    const sent = () => vi.mocked(sendJsonMessage).mock.calls;

    async function renderDriving() {
        const rendered = renderManualMode();
        await act(async () => { await rendered.result.current.handleManualMode(); });
        act(() => {
            rendered.result.current.handleJoyStart();
            rendered.result.current.handleJoyMove(joyEvent(0, 1));
        });
        vi.mocked(sendJsonMessage).mockClear();
        return rendered;
    }

    it('handleJoyStop sends zero velocity after the release debounce', async () => {
        const {result} = await renderDriving();
        act(() => {
            result.current.handleJoyStop();
        });
        // Not yet: the stop is held so a spurious pointerup cannot brake the mower.
        expect(sendJsonMessage).not.toHaveBeenCalledWith(ZERO_TWIST, false);
        act(() => {
            vi.advanceTimersByTime(150);
        });
        expect(sendJsonMessage).toHaveBeenCalledWith(ZERO_TWIST, false);
    });

    it('a stop immediately followed by a move never sends a zero and keeps the gesture', async () => {
        const {result} = await renderDriving();
        act(() => {
            result.current.handleJoyStop();
        });
        act(() => {
            vi.advanceTimersByTime(20);
            result.current.handleJoyMove(joyEvent(0, 1));
        });
        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(sendJsonMessage).not.toHaveBeenCalledWith(ZERO_TWIST, false);
        // The keepalive kept re-sending the last non-zero twist.
        const speeds = sent().map((call) => (call[0] as typeof ZERO_TWIST).twist.linear.x);
        expect(speeds.length).toBeGreaterThan(3);
        expect(speeds.every((x) => x > 0)).toBe(true);
    });

    it('a stop that is not followed by a move halts the keepalive after the debounce', async () => {
        const {result} = await renderDriving();
        act(() => {
            result.current.handleJoyStop();
            vi.advanceTimersByTime(150);
        });
        const sentAfterStop = sent().length;
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(sent().length).toBe(sentAfterStop);
        expect(sent()[sent().length - 1]?.[0]).toEqual(ZERO_TWIST);
    });

    it('an explicit Stop neutralizes at once, without waiting for the debounce', async () => {
        const {result} = await renderDriving();
        act(() => {
            result.current.handleJoyStop();
            result.current.handleStopIntent();
        });
        expect(sendJsonMessage).toHaveBeenCalledWith(ZERO_TWIST, false);
        const sentAfterStop = sent().length;
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(sent().length).toBe(sentAfterStop);
    });

    it('cleans up timers on unmount', async () => {
        const {result, unmount} = renderManualMode();
        await act(async () => {
            await result.current.handleManualMode();
        });
        expect(result.current.manualMode).toBe(true);
        unmount();
        // No assertion needed — just verifying no error/leak on unmount
    });
});
