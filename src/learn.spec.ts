import { describe, expect, it, vi } from 'vitest'
import { UpdateActions } from './actions.js'
import type { DevicesData } from './api.js'
import type DanteInstance from './main.js'

/**
 * Learn callbacks, against a two-device network where DeviceB ch2 is routed from DeviceA ch3.
 *
 * The rule these tests exist to protect is the Companion 2.0 one: a learn returns **only** the
 * options it learnt. Returning the rest would overwrite expressions the user typed into the fields
 * that were merely read.
 */

const A = '10.0.0.5'
const B = '10.0.0.6'

function devicesData(): DevicesData {
	return {
		[A]: {
			name: 'DeviceA',
			ports: { ARC: 4440 },
			latency: 2,
			sr: 48000,
			srOptions: ['44100', '48000'],
			pullup: '+0.1%',
			pullupOptions: ['0', '2'],
			encoding: 'PCM24',
			encodingOptions: ['16', '24'],
			output_levels: ['+18dBu', '+4dBu'],
			rx: { count: 2, 1: { number: 1, name: 'In 1' }, 2: { number: 2, name: 'In 2' } },
			tx: {
				count: 3,
				1: { number: 1, name: '01' },
				2: { number: 2, name: '02' },
				3: { number: 3, name: '03', friendlyName: 'Talkback' },
			},
		},
		[B]: {
			name: 'DeviceB',
			ports: { ARC: 4440 },
			latency: 5,
			sr: 96000,
			srOptions: ['48000', '96000'],
			rx: {
				count: 2,
				1: { number: 1, name: 'In 1' },
				// routed from DeviceA's channel 3, which the device reports by its label
				2: { number: 2, name: 'In 2', sourceDevice: 'DeviceA', sourceChannel: 'Talkback' },
			},
			tx: { count: 1, 1: { number: 1, name: '01' } },
		},
	}
}

/** Builds the per-device channel choice lists the way `updateChannelChoices` does. */
function channelChoicesFor(data: DevicesData, channelType: 'rx' | 'tx') {
	const byDevice: Record<string, { id: number; label: string }[]> = {}
	for (const device of Object.values(data)) {
		const io = device[channelType] as Record<string, { number?: number; name?: string }> | undefined
		if (!device.name || !io) continue
		byDevice[device.name] = Object.entries(io)
			.filter(([key]) => !isNaN(Number(key)))
			.map(([key, channel]) => ({ id: Number(key), label: channel?.name ?? '' }))
	}
	return byDevice
}

function definitions(data: DevicesData = devicesData()) {
	const self = {
		devicesData: data,
		devicesChoices: Object.entries(data).map(([ip, device]) => ({ id: ip, label: device.name! })),
		// derived from the devices' channels, as updateChannelChoices does in production - a fixture
		// with fewer choices than channels would let a learn return an unselectable value
		rxChannelsChoices: channelChoicesFor(data, 'rx'),
		txChannelsChoices: channelChoicesFor(data, 'tx'),
		setActionDefinitions: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
	UpdateActions(self)
	return (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
}

/** Invokes an action's learn callback with the given options. */
async function learn(actionId: string, options: Record<string, unknown>, data?: DevicesData) {
	const definition = definitions(data)[actionId]
	expect(definition?.learn, `${actionId} has no learn callback`).toBeDefined()
	return definition.learn({ id: 'a', controlId: 'b', actionId, options }, {})
}

describe('makeCrosspoint learn', () => {
	it('learns the source from what the destination is subscribed to', async () => {
		expect(await learn('makeCrosspoint', { destinationDeviceAddress: B, destinationChannelNumber: '2' })).toEqual({
			sourceChannelName: 'Talkback',
			sourceDeviceName: 'DeviceA',
		})
	})

	it('returns only the source fields, leaving the destination fields untouched', async () => {
		const learnt = await learn('makeCrosspoint', {
			destinationDeviceAddress: B,
			destinationChannelNumber: '2',
			sourceChannelName: 'old',
			sourceDeviceName: 'old',
		})
		expect(Object.keys(learnt).sort()).toEqual(['sourceChannelName', 'sourceDeviceName'])
	})

	it('accepts a device name as well as an IP', async () => {
		expect(
			await learn('makeCrosspoint', { destinationDeviceAddress: 'DeviceB', destinationChannelNumber: '2' }),
		).toEqual({ sourceChannelName: 'Talkback', sourceDeviceName: 'DeviceA' })
	})

	it('declines when the destination channel is not routed', async () => {
		expect(
			await learn('makeCrosspoint', { destinationDeviceAddress: B, destinationChannelNumber: '1' }),
		).toBeUndefined()
	})

	it('declines for an unknown device', async () => {
		expect(
			await learn('makeCrosspoint', { destinationDeviceAddress: 'Nope', destinationChannelNumber: '1' }),
		).toBeUndefined()
	})

	it('resolves a self-route to the device its own name', async () => {
		const data = devicesData()
		;(data[A].rx as Record<number, unknown>)[1] = {
			number: 1,
			name: 'In 1',
			sourceDevice: '.',
			sourceChannel: '01',
		}
		expect(await learn('makeCrosspoint', { destinationDeviceAddress: A, destinationChannelNumber: '1' }, data)).toEqual(
			{ sourceChannelName: '01', sourceDeviceName: 'DeviceA' },
		)
	})
})

describe('makeCrosspointDropDown learn', () => {
	it('learns the source device and its per-device channel key', async () => {
		expect(
			await learn('makeCrosspointDropDown', {
				destinationDevice: B,
				[`destinationChannel_${B}`]: 2,
			}),
		).toEqual({ sourceDevice: 'DeviceA', sourceChannel_DeviceA: 3 })
	})

	it('returns only the source fields', async () => {
		const learnt = await learn('makeCrosspointDropDown', {
			destinationDevice: B,
			[`destinationChannel_${B}`]: 2,
			sourceDevice: 'stale',
		})
		expect(Object.keys(learnt).sort()).toEqual(['sourceChannel_DeviceA', 'sourceDevice'].sort())
	})

	it('declines when the destination channel is unrouted', async () => {
		expect(
			await learn('makeCrosspointDropDown', { destinationDevice: B, [`destinationChannel_${B}`]: 1 }),
		).toBeUndefined()
	})

	it('declines when the source device is not on the network', async () => {
		const data = devicesData()
		;(data[B].rx as Record<number, { sourceDevice: string }>)[2].sourceDevice = 'AbsentDevice'
		expect(
			await learn('makeCrosspointDropDown', { destinationDevice: B, [`destinationChannel_${B}`]: 2 }, data),
		).toBeUndefined()
	})
})

describe('channel name learn', () => {
	it('setRxChannelName learns the current name', async () => {
		expect(await learn('setRxChannelName', { device: A, [`channel_${A}`]: 2 })).toEqual({ newName: 'In 2' })
	})

	it('setTxChannelName prefers the channel label over the canonical name', async () => {
		expect(await learn('setTxChannelName', { device: A, [`channel_${A}`]: 3 })).toEqual({ newName: 'Talkback' })
	})

	it('setTxChannelName falls back to the canonical name when there is no label', async () => {
		expect(await learn('setTxChannelName', { device: A, [`channel_${A}`]: 1 })).toEqual({ newName: '01' })
	})

	it('declines for a channel the device does not have', async () => {
		expect(await learn('setRxChannelName', { device: A, [`channel_${A}`]: 99 })).toBeUndefined()
	})
})

describe('settings learn', () => {
	it('setLatency learns from the selected device', async () => {
		expect(await learn('setLatency', { destinationDevice: A })).toEqual({ latency: 2 })
		expect(await learn('setLatency', { destinationDevice: B })).toEqual({ latency: 5 })
	})

	it('setSampleRate learns into the selected device its own option key', async () => {
		expect(await learn('setSampleRate', { device: 'DeviceA' })).toEqual({ sr_DeviceA: '48000' })
		expect(await learn('setSampleRate', { device: 'DeviceB' })).toEqual({ sr_DeviceB: '96000' })
	})

	it('setSampleRate declines when the current rate is not one of the offered options', async () => {
		const data = devicesData()
		data[A].sr = 192000
		expect(await learn('setSampleRate', { device: A }, data)).toBeUndefined()
	})

	it('setPullup learns the code behind the reported label', async () => {
		// device reports '+0.1%', whose code in DANTE_CONST.PULLUPS is 2
		expect(await learn('setPullup', { device: 'DeviceA' })).toEqual({ pullup_DeviceA: '2' })
	})

	it('setPullup declines for a device that does not support pullup', async () => {
		expect(await learn('setPullup', { device: B })).toBeUndefined()
	})

	it('setOutputLevel learns the level of the selected channel', async () => {
		// output_levels is indexed from 0, so channel 2 is '+4dBu', whose code is 2
		expect(await learn('setOutputLevel', { device: A, [`channel_${A}`]: 2 })).toEqual({ level: '2' })
		expect(await learn('setOutputLevel', { device: A, [`channel_${A}`]: 1 })).toEqual({ level: '1' })
	})

	it('setOutputLevel declines for a device that reports no levels', async () => {
		expect(await learn('setOutputLevel', { device: B, [`channel_${B}`]: 1 })).toBeUndefined()
	})
})

describe('learnt values are selectable', () => {
	/**
	 * A learnt value has to equal one of the ids its own dropdown offers, or Companion has nothing
	 * to select and the learn silently does nothing. The two are easy to drift apart: choice ids are
	 * strings here, while the underlying protocol values are numbers.
	 */
	const cases: [string, Record<string, unknown>, string][] = [
		['setSampleRate', { device: 'DeviceA' }, 'sr_DeviceA'],
		['setPullup', { device: 'DeviceA' }, 'pullup_DeviceA'],
		['setOutputLevel', { device: 'DeviceA', channel_DeviceA: 1 }, 'level'],
		[
			'makeCrosspointDropDown',
			{ destinationDevice: 'DeviceB', destinationChannel_DeviceB: 2 },
			'sourceChannel_DeviceA',
		],
	]

	it.each(cases)('%s learns a value its dropdown can select', async (actionId, options, optionId) => {
		const learnt = await learn(actionId, options)
		expect(learnt).toBeDefined()

		const option = (definitions()[actionId].options ?? []).find(
			(candidate: { id: string }) => candidate.id === optionId,
		)
		expect(option?.choices, `${actionId}.${optionId} has no choices`).toBeDefined()
		expect(option.choices.map((choice: { id: unknown }) => choice.id)).toContain(learnt[optionId])
	})
})

describe('the 2.0 contract', () => {
	const cases: [string, Record<string, unknown>, string[]][] = [
		[
			'makeCrosspoint',
			{ destinationDeviceAddress: B, destinationChannelNumber: '2' },
			['sourceChannelName', 'sourceDeviceName'],
		],
		['setRxChannelName', { device: A, [`channel_${A}`]: 1 }, ['newName']],
		['setTxChannelName', { device: A, [`channel_${A}`]: 3 }, ['newName']],
		['setLatency', { destinationDevice: A }, ['latency']],
		['setSampleRate', { device: 'DeviceA' }, ['sr_DeviceA']],
		['setPullup', { device: 'DeviceA' }, ['pullup_DeviceA']],
		['setOutputLevel', { device: A, [`channel_${A}`]: 1 }, ['level']],
	]

	it.each(cases)('%s returns only the fields it learnt', async (actionId, options, expected) => {
		const learnt = await learn(actionId, options)
		expect(Object.keys(learnt).sort()).toEqual([...expected].sort())
	})
})
