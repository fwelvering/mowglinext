import {describe, it, expect} from 'vitest'
import schema from '../../../asserts/mower_config.schema.json'
import generated from '../types/settings.generated.ts?raw'
import {renderSettingsTypes} from '../../scripts/gen-settings-types.mjs'

// Anti-drift guard for the generated settings types: src/types/settings.generated.ts is rendered from
// the settings JSON schema, so a new or retyped schema key must be followed by
//   cd gui/web && npm run generate:settings-types
describe('settings.generated.ts', () => {
    it('matches the settings JSON schema', () => {
        expect(generated.replace(/\r\n/g, '\n')).toBe(renderSettingsTypes(schema))
    })

    it('types the NTRIP keys the schema does not describe', () => {
        for (const key of ['ntrip_host', 'ntrip_port', 'ntrip_user', 'ntrip_password', 'ntrip_mountpoint']) {
            expect(generated).toContain(`    ${key}?:`)
        }
    })

    it('types every schema key', () => {
        const keys = Object.values(schema.properties).flatMap((group) => Object.keys(group.properties))
        expect(keys.length).toBeGreaterThan(100)
        for (const key of keys) {
            expect(generated).toContain(`    ${key}?:`)
        }
    })
})
