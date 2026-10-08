import { describe, expect, it, vi } from 'vitest'
import { deviceOptionValue, type DevicesData } from '../index.js'
import type DanteInstance from '../../main.js'

/**
 * The key forms `deviceOptionValue` has to accept.
 *
 * Per-device option ids are suffixed with the device name, which is sanitised so Companion can use
 * it as an id. A config saved before that holds the unsanitised name, and one saved before devices
 * were keyed by name at all holds an address - both must still resolve, or upgrading the module
 * would silently empty every per-device field of a device whose name needed sanitising.
 */

const A = '10.0.0.5'
const MESSY = 'Studio 1 (Rack A)'
const CLEAN = 'Studio_1__Rack_A_'

function instance(): DanteInstance {
	return {
		devicesData: { [A]: { name: MESSY, ports: { ARC: 4440 } } } as unknown as DevicesData,
		log: vi.fn(),
	} as unknown as DanteInstance
}

describe('deviceOptionValue key forms', () => {
	it('reads the sanitised name, which is how fields are declared now', () => {
		expect(deviceOptionValue(instance(), { [`channel_${CLEAN}`]: 7 }, 'channel', MESSY, 0)).toBe(7)
	})

	it('still reads the unsanitised name a config saved before sanitising holds', () => {
		expect(deviceOptionValue(instance(), { [`channel_${MESSY}`]: 7 }, 'channel', MESSY, 0)).toBe(7)
	})

	it('still reads the address form, which sanitising leaves untouched', () => {
		expect(deviceOptionValue(instance(), { [`channel_${A}`]: 7 }, 'channel', A, 0)).toBe(7)
	})

	it('reads the sanitised name for a device that is offline, whose name cannot be resolved', () => {
		// deviceByIdentifier finds nothing, so the stored identifier is all there is to key on
		const self = { devicesData: {} as DevicesData, log: vi.fn() } as unknown as DanteInstance
		expect(deviceOptionValue(self, { [`channel_${CLEAN}`]: 7 }, 'channel', MESSY, 0)).toBe(7)
	})

	it('prefers the current key when a config holds both forms', () => {
		const options = { [`channel_${CLEAN}`]: 7, [`channel_${MESSY}`]: 9 }
		expect(deviceOptionValue(instance(), options, 'channel', MESSY, 0)).toBe(7)
	})

	it('returns a stored 0 rather than falling through it, since 0 clears a crosspoint', () => {
		const options = { [`sourceChannel_${CLEAN}`]: 0, [`sourceChannel_${MESSY}`]: 5 }
		expect(deviceOptionValue(instance(), options, 'sourceChannel', MESSY, -1)).toBe(0)
	})

	it('falls back when no key matches', () => {
		expect(deviceOptionValue(instance(), {}, 'channel', MESSY, 0)).toBe(0)
	})
})
