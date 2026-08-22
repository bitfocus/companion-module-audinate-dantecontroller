import { describe, expect, it, vi } from 'vitest'
import { UpdateFeedbacks } from '../feedbacks.js'
import { scheduleCheckFeedbacks, type DevicesData } from '../api/index.js'
import type DanteInstance from '../main.js'

const DEST = '10.0.0.5'
const SOURCE = '10.0.0.6'

/**
 * DeviceA ch1 is self-routed, ch2 comes from DeviceB, ch3 is unrouted, ch4 names a source that is
 * not there. Status codes are the ones real devices report - see DANTE_CONST.SUBSCRIPTION_STATUS.
 */
function devicesData(): DevicesData {
	return {
		[DEST]: {
			name: 'DeviceA',
			ports: { ARC: 4440 },
			rx: {
				count: 4,
				// a self-route, which the device reports with the '.' shorthand
				1: { number: 1, name: 'In 1', sourceDevice: '.', sourceChannel: 'Local Out', subscriptionStatus: 4 },
				2: { number: 2, name: 'In 2', sourceDevice: 'DeviceB', sourceChannel: 'Talkback', subscriptionStatus: 9 },
				3: { number: 3, name: 'In 3' },
				// configured but not resolving: the source is not on the network
				4: { number: 4, name: 'In 4', sourceDevice: 'AbsentDevice', sourceChannel: 'Out 1', subscriptionStatus: 1 },
			},
			tx: { count: 1, 1: { number: 1, name: 'Local Out' } },
		},
		[SOURCE]: {
			name: 'DeviceB',
			ports: { ARC: 4440 },
			rx: { count: 1, 1: { number: 1, name: 'In 1' } },
			tx: { count: 2, 1: { number: 1, name: '01' }, 2: { number: 2, name: '02', friendlyName: 'Talkback' } },
		},
	}
}

function instance(data: DevicesData = devicesData()) {
	return {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		devicesData: data,
		devicesChoices: Object.entries(data).map(([, device]) => ({ id: device.name!, label: device.name! })),
		rxChannelsChoices: { DeviceA: [{ id: 1, label: 'In 1' }], DeviceB: [{ id: 1, label: 'In 1' }] },
		txChannelsChoices: { DeviceA: [{ id: 1, label: 'Local Out' }], DeviceB: [{ id: 1, label: '01' }] },
		setFeedbackDefinitions: vi.fn(),
		checkFeedbacksById: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

function definition(self: DanteInstance) {
	UpdateFeedbacks(self)
	return (self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0].channel_subscription
}

function read(channel: number, device = 'DeviceA', self: DanteInstance = instance()) {
	return definition(self).callback(
		{ id: `cs-${device}-${channel}`, options: { device, [`channel_${device}`]: channel } },
		{},
	)
}

const EMPTY = { connected: false, device: { name: '', ip: '' }, channel: { name: '', number: 0 } }

describe('Channel Subscription feedback', () => {
	it('is a value feedback with the requested name and description', () => {
		const definitions = definition(instance())
		expect(definitions.type).toBe('value')
		expect(definitions.name).toBe('Channel Subscription')
		expect(definitions.description).toBe('Returns the channel a destination is subscribed to')
	})

	it('offers a Device picker and a per-device Channel picker', () => {
		const options = definition(instance()).options as { id: string; label: string }[]
		expect(options.find((option) => option.id === 'device')?.label).toBe('Device')
		const channels = options.filter((option) => option.id.startsWith('channel_'))
		expect(channels.length).toBeGreaterThan(0)
		expect(channels.every((option) => option.label === 'Channel')).toBe(true)
	})

	it('offers only devices with receive channels, as the destination pickers do', () => {
		const picker = (definition(instance()).options as { id: string; choices?: { id: string }[] }[]).find(
			(option) => option.id === 'device',
		)
		expect(picker?.choices?.map((choice) => choice.id)).toEqual(['DeviceA', 'DeviceB'])
	})

	it('reports the source device and channel of a cross-device subscription', () => {
		expect(read(2)).toEqual({
			connected: true,
			device: { name: 'DeviceB', ip: SOURCE },
			channel: { name: 'Talkback', number: 2 },
		})
	})

	it('resolves a self-route to the device its own name and address', () => {
		// the device reports '.' rather than naming itself
		expect(read(1)).toEqual({
			connected: true,
			device: { name: 'DeviceA', ip: DEST },
			channel: { name: 'Local Out', number: 1 },
		})
	})

	it('returns the same shape with empty values when nothing is subscribed', () => {
		expect(read(3)).toEqual(EMPTY)
	})

	it('returns the same shape for an unknown device', () => {
		expect(read(1, 'Nope')).toEqual(EMPTY)
	})

	it('returns the same shape when no channel is selected', () => {
		const self = instance()
		expect(definition(self).callback({ id: 'cs', options: { device: 'DeviceA' } }, {})).toEqual(EMPTY)
	})

	it('accepts a device stored by address', () => {
		expect(read(2, DEST)).toMatchObject({ device: { name: 'DeviceB' } })
	})

	it('reports channel 0 when the source device is not on the network', () => {
		// the subscription still names its source, so the name is reported even without a number
		const data = devicesData()
		delete (data as Record<string, unknown>)[SOURCE]
		expect(read(2, 'DeviceA', instance(data))).toEqual({
			connected: true,
			device: { name: 'DeviceB', ip: '' },
			channel: { name: 'Talkback', number: 0 },
		})
	})

	it('reports connected when the subscription is carrying audio', () => {
		expect(read(2)).toMatchObject({ connected: true })
		expect(read(1)).toMatchObject({ connected: true })
	})

	it('reports not connected for a subscription that exists but is not working', () => {
		// the source is named but absent, so the device reports an unresolved status
		expect(read(4)).toMatchObject({
			connected: false,
			device: { name: 'AbsentDevice', ip: '' },
			channel: { name: 'Out 1', number: 0 },
		})
	})

	it('reports not connected when nothing is subscribed at all', () => {
		expect(read(3)).toMatchObject({ connected: false })
	})

	it('distinguishes "not working" from "not subscribed" by the rest of the object', () => {
		// both are connected:false, but only one names a source
		expect(read(4)).toMatchObject({ device: { name: 'AbsentDevice' } })
		expect(read(3)).toMatchObject({ device: { name: '' } })
	})

	it('reports the name the destination holds, not the source current label', () => {
		// a source renamed after the subscription was made still reports the old name until re-subscribed
		const data = devicesData()
		;(data[SOURCE].tx as Record<number, { friendlyName?: string }>)[2].friendlyName = 'Renamed'
		expect(read(2, 'DeviceA', instance(data))).toMatchObject({ channel: { name: 'Talkback' } })
	})
})

describe('Channel Subscription checking paths', () => {
	function tracked(channel: number, self: DanteInstance) {
		definition(self).callback({ id: 'cs-tracked', options: { device: 'DeviceA', [`channel_DeviceA`]: channel } }, {})
		return () => (self.checkFeedbacksById as ReturnType<typeof vi.fn>).mock.calls.flat()
	}

	it('is re-checked when the destination device changes', () => {
		const self = instance()
		const checked = tracked(2, self)
		scheduleCheckFeedbacks(self, DEST)
		expect(checked()).toContain('cs-tracked')
	})

	it('is re-checked when the source device changes', () => {
		// the source supplies the channel number, so its transmit channels matter too
		const self = instance()
		const checked = tracked(2, self)
		scheduleCheckFeedbacks(self, SOURCE)
		expect(checked()).toContain('cs-tracked')
	})

	it('an unsubscribed channel depends only on its destination', () => {
		// registering a missing source as a wildcard would re-check it on every device's traffic
		const self = instance()
		const checked = tracked(3, self)
		scheduleCheckFeedbacks(self, SOURCE)
		expect(checked()).not.toContain('cs-tracked')
	})

	it('an unsubscribed channel is still re-checked by its own destination', () => {
		const self = instance()
		const checked = tracked(3, self)
		scheduleCheckFeedbacks(self, DEST)
		expect(checked()).toContain('cs-tracked')
	})
})
