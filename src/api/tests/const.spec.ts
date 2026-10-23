import { describe, expect, it } from 'vitest'
import { object2choices, object2PartialChoices, array2choices, displayChannelChoices } from '../choices.js'
import { DANTE_CONST } from '../const.js'
import { channelDisplayLabel, isSubscriptionConnected, validateDanteName } from '../protocol-rules.js'
import { ch } from '../../tests/ids.js'

describe('object2choices', () => {
	it('converts an id-to-label map into a choices array', () => {
		expect(object2choices({ 1: 'One', 2: 'Two' })).toEqual([
			{ id: '1', label: 'One' },
			{ id: '2', label: 'Two' },
		])
	})

	it('returns an empty array for an empty map', () => {
		expect(object2choices({})).toEqual([])
	})
})

describe('object2PartialChoices', () => {
	it('only includes entries whose id is present in optionsArray', () => {
		const result = object2PartialChoices({ 0: 'NONE', 1: 'A', 2: 'B' }, ['0', '2'])
		expect(result).toEqual([
			{ id: '0', label: 'NONE' },
			{ id: '2', label: 'B' },
		])
	})

	it('returns an empty array when optionsArray is undefined', () => {
		expect(object2PartialChoices({ 0: 'NONE' }, undefined)).toEqual([])
	})
})

describe('array2choices', () => {
	it('maps raw values to choices using the value itself as the label by default', () => {
		expect(array2choices([1, 2])).toEqual([
			{ id: 1, label: '1' },
			{ id: 2, label: '2' },
		])
	})

	it('uses the mapping function to derive labels when given', () => {
		const result = array2choices([48000, 96000], (hz) => `${hz / 1000} kHz`)
		expect(result).toEqual([
			{ id: 48000, label: '48 kHz' },
			{ id: 96000, label: '96 kHz' },
		])
	})

	it('returns undefined when array is undefined', () => {
		expect(array2choices(undefined)).toBeUndefined()
	})
})

describe('isSubscriptionConnected', () => {
	// Codes below are as observed from real devices via an rx-channel query, with the corresponding
	// routes live and healthy in Dante Controller.

	it('treats a self-route as connected', () => {
		// NAM-262de4 ch1: source device '.', source channel 'AMP Mon 1'
		expect(isSubscriptionConnected(0x0004)).toBe(true)
	})

	it('treats a cross-device unicast route as connected', () => {
		// NAM-262de4 ch2 <- TAV-MINEOLA22XLR CH1
		expect(isSubscriptionConnected(0x0009)).toBe(true)
	})

	it('treats a cross-device multicast route as connected', () => {
		// NAM-262de4 ch3 <- TAV-MINEOLA22XLR CH2
		expect(isSubscriptionConnected(0x000a)).toBe(true)
	})

	it('treats an unrouted channel as not connected', () => {
		expect(isSubscriptionConnected(DANTE_CONST.SUBSCRIPTION_STATUS.NONE)).toBe(false)
	})

	it('treats an unknown status as not connected', () => {
		expect(isSubscriptionConnected(0x0001)).toBe(false) // reference: unresolved, source unavailable
		expect(isSubscriptionConnected(0xffff)).toBe(false)
	})

	it('treats a missing status as not connected', () => {
		expect(isSubscriptionConnected(undefined)).toBe(false)
	})

	it('keeps the unverified legacy code accepted', () => {
		expect(isSubscriptionConnected(DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_UNVERIFIED)).toBe(true)
	})
})

describe('validateDanteName', () => {
	it('accepts ordinary device names', () => {
		expect(validateDanteName('NAM-262de4')).toBeUndefined()
		expect(validateDanteName('Amp1')).toBeUndefined()
	})

	it('accepts an empty name, which the reset actions use to mean "factory default"', () => {
		expect(validateDanteName('')).toBeUndefined()
	})

	it('rejects a name longer than 31 characters', () => {
		expect(validateDanteName('a'.repeat(31))).toBeUndefined()
		expect(validateDanteName('a'.repeat(32))).toMatch(/31 characters or fewer/)
	})

	it('rejects characters a device will not accept', () => {
		expect(validateDanteName('My Device')).toMatch(/letters, digits and hyphens/)
		expect(validateDanteName('amp!')).toBeDefined()
		expect(validateDanteName('caf\u00e9')).toBeDefined() // non-ASCII would be mangled by Buffer.from(.., 'ascii')
	})

	it('rejects a leading or trailing hyphen', () => {
		expect(validateDanteName('-amp')).toMatch(/start or end/)
		expect(validateDanteName('amp-')).toMatch(/start or end/)
		expect(validateDanteName('a-b')).toBeUndefined()
	})

	it('allows a colon only in channel names', () => {
		expect(validateDanteName('CH1:Amp')).toBeDefined()
		expect(validateDanteName('CH1:Amp', { allowColon: true })).toBeUndefined()
	})

	it('rejects a leading or trailing colon in channel names', () => {
		expect(validateDanteName(':CH1', { allowColon: true })).toMatch(/start or end/)
		expect(validateDanteName('CH1:', { allowColon: true })).toMatch(/start or end/)
	})

	it('allows a space inside a channel name, as devices report them', () => {
		// a Neutrik NA2-D-LINE's own name for a channel - which renaming it back has to be able to set
		const channel = { allowColon: true, allowSpace: true }
		expect(validateDanteName('01 IMAG-LTC-XLR-LOCALBACKUP', channel)).toBeUndefined()
		expect(validateDanteName(' CH1', channel)).toMatch(/start or end/)
		expect(validateDanteName('CH1 ', channel)).toMatch(/start or end/)
		// device names still may not
		expect(validateDanteName('IMAG IO2')).toBeDefined()
	})
})

describe('channelDisplayLabel', () => {
	it('shows Ch <n> for an empty name or a placeholder like 01 n/a', () => {
		expect(channelDisplayLabel(undefined, 1)).toBe('Ch 1')
		expect(channelDisplayLabel('', 2)).toBe('Ch 2')
		expect(channelDisplayLabel('  ', 3)).toBe('Ch 3')
		expect(channelDisplayLabel('01 n/a', 1)).toBe('Ch 1')
		expect(channelDisplayLabel('02 N/A', 2)).toBe('Ch 2')
		expect(channelDisplayLabel('n/a', 7)).toBe('Ch 7')
	})

	it('keeps any real name, including ones that only mention n/a', () => {
		expect(channelDisplayLabel('01', 1)).toBe('01')
		expect(channelDisplayLabel('01 IMAG-LTC-XLR-LOCALBACKUP', 1)).toBe('01 IMAG-LTC-XLR-LOCALBACKUP')
		expect(channelDisplayLabel('Mic n/a backup', 4)).toBe('Mic n/a backup')
	})
})

describe('displayChannelChoices', () => {
	it('relabels placeholder channels and keeps every id', () => {
		expect(
			displayChannelChoices([
				{ id: ch(1), label: '01 n/a' },
				{ id: ch(2), label: 'Mic 1' },
			]),
		).toEqual([
			{ id: ch(1), label: 'Ch 1' },
			{ id: ch(2), label: 'Mic 1' },
		])
	})
})
