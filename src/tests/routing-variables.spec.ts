import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	cancelCheckVariables,
	cancelUpdateData,
	danteDiscovery,
	danteDeviceIdFromTxt,
	DANTE_CONST,
	parseReply,
	type AudioRxChannel,
	type DevicesData,
	type MdnsResponsePacket,
} from '../api/index.js'
import type DanteInstance from '../main.js'
import { VariablePublisher } from '../variable-publisher.js'
import { CheckVariables, UpdateVariableDefinitions } from '../variables.js'
import { ch, id, ip, name } from './ids.js'

const STAGE = ip('10.0.0.5')
const AMP = ip('10.0.0.6')
const STAGE_ID = id(1)
const AMP_ID = id(2)

function devicesData(): DevicesData {
	return {
		[STAGE]: {
			name: name('Stage Box'),
			id: STAGE_ID,
			ports: { ARC: 4440 },
			audioTx: {
				count: 2,
				1: { number: ch(1), name: '01', friendlyName: 'Mic 1' },
				2: { number: ch(2), name: '02' },
			},
			audioRx: { count: 0 },
		},
		[AMP]: {
			name: name('Amp'),
			id: AMP_ID,
			ports: { ARC: 4440 },
			audioRx: {
				count: 2,
				1: { number: ch(1), name: 'Left', sourceDevice: 'Stage Box', sourceChannel: 'Mic 1', subscriptionStatus: 9 },
				2: { number: ch(2), name: 'Right' },
			},
			videoRx: {
				count: 1,
				1: {
					number: ch(1),
					name: 'HDMI',
					sourceDevice: 'Encoder',
					sourceChannel: 'Cam',
					subscriptionResolved: 1,
					subscriptionActive: 1,
				},
			},
		},
	}
}

function instance(config: Record<string, unknown> = {}) {
	return {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: false, verbose: false, ...config },
		devicesData: devicesData(),
		devicesChoices: [
			{ id: AMP_ID, label: 'Amp' },
			{ id: STAGE_ID, label: 'Stage Box' },
		],
		rxChannelsChoices: {
			[AMP_ID]: [
				{ id: ch(1), label: 'Left' },
				{ id: ch(2), label: 'Right' },
			],
		},
		txChannelsChoices: {
			[STAGE_ID]: [
				{ id: ch(1), label: 'Mic 1' },
				{ id: ch(2), label: '02' },
			],
		},
		videoRxChannelsChoices: { [AMP_ID]: [{ id: ch(1), label: 'HDMI' }] },
		videoTxChannelsChoices: {},
		deviceIdsByName: { [name('Amp')]: AMP_ID, [name('Stage Box')]: STAGE_ID },
		deviceNamesById: { [AMP_ID]: name('Amp'), [STAGE_ID]: name('Stage Box') },
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

/** The same network before any device id has been seen: no ids, so nothing keyed by one. */
function instanceWithoutIds() {
	const self = instance()
	for (const device of Object.values(self.devicesData)) delete device.id
	self.devicesChoices = []
	self.rxChannelsChoices = {}
	self.txChannelsChoices = {}
	self.videoRxChannelsChoices = {}
	self.deviceIdsByName = {}
	self.deviceNamesById = {}
	return self
}

const definitionCalls = (self: DanteInstance) => (self.setVariableDefinitions as ReturnType<typeof vi.fn>).mock.calls
const valueCalls = (self: DanteInstance) => (self.setVariableValues as ReturnType<typeof vi.fn>).mock.calls

describe('VariablePublisher', () => {
	const host = () => ({ setVariableDefinitions: vi.fn(), setVariableValues: vi.fn() })

	it('sends definitions only when they change', () => {
		const target = host()
		const publisher = new VariablePublisher(target)

		expect(publisher.setDefinitions({ a: { name: 'A' }, b: { name: 'B' } } as never)).toBe(true)
		// same set in another order
		expect(publisher.setDefinitions({ b: { name: 'B' }, a: { name: 'A' } } as never)).toBe(false)
		expect(publisher.setDefinitions({ a: { name: 'A renamed' }, b: { name: 'B' } } as never)).toBe(true)
		expect(target.setVariableDefinitions).toHaveBeenCalledTimes(2)
	})

	it('sends only the values that changed, and none for undefined variables', () => {
		const target = host()
		const publisher = new VariablePublisher(target)
		publisher.setDefinitions({ a: { name: 'A' }, b: { name: 'B' } } as never)

		expect(publisher.setValues({ a: 1, b: 2, c: 3 } as never)).toBe(2)
		expect(publisher.setValues({ a: 1, b: 3 } as never)).toBe(1)
		expect(publisher.setValues({ a: 1, b: 3 } as never)).toBe(0)
		expect(target.setVariableValues.mock.calls).toEqual([[{ a: 1, b: 2 }], [{ b: 3 }]])
	})

	it('compares arrays by content', () => {
		const target = host()
		const publisher = new VariablePublisher(target)
		publisher.setDefinitions({ names: { name: 'Names' } } as never)

		publisher.setValues({ names: ['In 1', 'In 2'] } as never)
		publisher.setValues({ names: ['In 1', 'In 2'] } as never)
		publisher.setValues({ names: ['In 1', 'In 3'] } as never)
		expect(target.setVariableValues).toHaveBeenCalledTimes(2)
	})

	it('follows the host: a new definition starts empty, a removed one is forgotten', () => {
		const target = host()
		const publisher = new VariablePublisher(target)
		publisher.setDefinitions({ a: { name: 'A' } } as never)

		// the host already holds '' for a new variable, so sending it again is redundant
		expect(publisher.setValues({ a: '' } as never)).toBe(0)
		publisher.setValues({ a: 'set' } as never)

		publisher.setDefinitions({} as never)
		publisher.setDefinitions({ a: { name: 'A' } } as never)
		// redefined after removal, so the host holds '' again and 'set' must be re-sent
		expect(publisher.setValues({ a: 'set' } as never)).toBe(1)
	})
})

describe('danteDeviceIdFromTxt', () => {
	it('reads and lower-cases the id key', () => {
		expect(
			danteDeviceIdFromTxt([Buffer.from('txtvers=1'), Buffer.from('id=001DC1FFFE0A1B2C'), Buffer.from('mf=Audinate')]),
		).toBe('001dc1fffe0a1b2c')
		expect(danteDeviceIdFromTxt('id=0000c0a80a050001')).toBe('0000c0a80a050001')
	})

	it('ignores a missing or malformed id', () => {
		expect(danteDeviceIdFromTxt([Buffer.from('model=DAI2')])).toBeUndefined()
		expect(danteDeviceIdFromTxt([Buffer.from('id=001dc1')])).toBeUndefined()
		expect(danteDeviceIdFromTxt([Buffer.from('rid=001dc1fffe0a1b2c')])).toBeUndefined()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	/** A CMC TXT answer for `deviceName`, as it arrives behind the PTR record that announces it. */
	function cmcTxt(deviceName: string, deviceId: string): MdnsResponsePacket {
		return {
			answers: [{ type: 'PTR', name: '_netaudio-cmc._udp.local', data: `${deviceName}._netaudio-cmc._udp.local` }],
			additionals: [
				{ type: 'TXT', name: `${deviceName}._netaudio-cmc._udp.local`, data: [Buffer.from(`id=${deviceId}`)] },
				// an ARC TXT record carries no device id and must not be read as one
				{ type: 'TXT', name: 'Amp._netaudio-arc._udp.local', data: [Buffer.from('id=ffffffffffffffff')] },
			],
		}
	}

	function discover(self: DanteInstance, response: MdnsResponsePacket, from = STAGE) {
		;(self as unknown as { mdns: { query: ReturnType<typeof vi.fn> } }).mdns = { query: vi.fn() }
		danteDiscovery(self, response, { address: from, family: 'IPv4', port: 5353, size: 0 })
	}

	it('records the id from a CMC TXT answer and asks for it with the SRV record', () => {
		vi.useFakeTimers()
		const self = instanceWithoutIds()

		discover(self, cmcTxt('Stage Box', '001dc1fffe0a9999'))
		cancelUpdateData(self)

		expect(self.deviceIdsByName).toEqual({ 'Stage Box': '001dc1fffe0a9999' })
		expect(self.deviceNamesById).toEqual({ '001dc1fffe0a9999': 'Stage Box' })
		const query = (self.mdns.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(query.questions).toEqual([
			{ name: 'Stage Box._netaudio-cmc._udp.local', type: 'SRV' },
			{ name: 'Stage Box._netaudio-cmc._udp.local', type: 'TXT' },
		])
	})

	it('gives a device registered before its id arrived its id, channel choices and dropdown entry', () => {
		vi.useFakeTimers()
		const self = instanceWithoutIds()
		expect(self.devicesChoices).toEqual([])

		discover(self, cmcTxt('Stage Box', STAGE_ID))
		cancelUpdateData(self)

		expect(self.devicesData[STAGE].id).toBe(STAGE_ID)
		expect(self.devicesChoices).toEqual([{ id: STAGE_ID, label: 'Stage Box' }])
		expect(self.txChannelsChoices[STAGE_ID]).toEqual([
			{ id: 1, label: 'Mic 1' },
			{ id: 2, label: '02' },
		])
		// the other device's id has not arrived, so it is still not offered
		expect(self.devicesData[AMP].id).toBeUndefined()
		expect(self.rxChannelsChoices[AMP_ID]).toBeUndefined()
	})
})

describe.each([
	{ mode: 'ids', amp: AMP_ID, stage: STAGE_ID },
	{ mode: 'names', amp: 'Amp', stage: 'Stage_Box' },
])('routing variables keyed by $mode', ({ mode, amp, stage }) => {
	const keyed = () => instance({ variableKeys: mode })

	it('defines one variable per channel, plus the id and name of each device', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)

		expect(Object.keys(definitionCalls(self)[0][0]).sort()).toEqual(
			[
				`${amp}_device_id`,
				`${amp}_device_name`,
				`${amp}_rx_1_name`,
				`${amp}_rx_1_source`,
				`${amp}_rx_1_source_id`,
				`${amp}_rx_1_connected`,
				`${amp}_rx_1_status`,
				`${amp}_rx_2_name`,
				`${amp}_rx_2_source`,
				`${amp}_rx_2_source_id`,
				`${amp}_rx_2_connected`,
				`${amp}_rx_2_status`,
				`${amp}_rx_video_1_name`,
				`${amp}_rx_video_1_source`,
				`${amp}_rx_video_1_source_id`,
				`${amp}_rx_video_1_connected`,
				`${amp}_rx_video_1_status`,
				`${stage}_device_id`,
				`${stage}_device_name`,
				`${stage}_tx_1_name`,
				`${stage}_tx_2_name`,
			].sort(),
		)
	})

	it('publishes sources as channel@device and transmit names as their subscription names', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		expect(valueCalls(self)[0][0]).toEqual({
			[`${amp}_device_id`]: AMP_ID,
			[`${amp}_device_name`]: 'Amp',
			[`${amp}_rx_1_name`]: 'Left',
			[`${amp}_rx_1_source`]: 'Mic 1@Stage Box',
			[`${amp}_rx_1_source_id`]: `${STAGE_ID}/1`,
			[`${amp}_rx_1_connected`]: true,
			[`${amp}_rx_1_status`]: 'connected (0x0009)',
			[`${amp}_rx_2_name`]: 'Right',
			// not subscribed: false, and its status stays at the '' every new variable starts as
			[`${amp}_rx_2_connected`]: false,
			[`${amp}_rx_video_1_name`]: 'HDMI',
			[`${amp}_rx_video_1_source`]: 'Cam@Encoder',
			[`${amp}_rx_video_1_connected`]: true,
			[`${amp}_rx_video_1_status`]: 'active',
			[`${stage}_device_id`]: STAGE_ID,
			[`${stage}_device_name`]: 'Stage Box',
			[`${stage}_tx_1_name`]: 'Mic 1',
			[`${stage}_tx_2_name`]: '02',
		})
	})

	it('sends one value when one subscription changes', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		self.devicesData[AMP].audioRx![2] = {
			number: ch(2),
			name: 'Right',
			sourceDevice: 'Stage Box',
			sourceChannel: '02',
			subscriptionStatus: 9,
		}
		CheckVariables(self, AMP, 'rx')

		expect(valueCalls(self)[1][0]).toEqual({
			[`${amp}_rx_2_source`]: '02@Stage Box',
			[`${amp}_rx_2_source_id`]: `${STAGE_ID}/2`,
			[`${amp}_rx_2_connected`]: true,
			[`${amp}_rx_2_status`]: 'connected (0x0009)',
		})
	})

	it('does not re-send definitions when only a channel is renamed', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)
		self.rxChannelsChoices[AMP_ID]![0] = { id: ch(1), label: 'Left (FOH)' }
		self.devicesData[AMP].audioRx![1].name = 'Left (FOH)'
		UpdateVariableDefinitions(self)
		CheckVariables(self, AMP, 'rx_names')

		expect(definitionCalls(self)).toHaveLength(1)
		expect(valueCalls(self).at(-1)?.[0]).toMatchObject({ [`${amp}_rx_1_name`]: 'Left (FOH)' })
	})

	it('is skipped for categories that cannot change it', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)
		CheckVariables(self)
		CheckVariables(self, AMP, 'latency')

		expect(valueCalls(self)).toHaveLength(1)
	})

	it('can be turned off', () => {
		const self = instance({ variableKeys: mode, routingVariables: false })
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		expect(definitionCalls(self)[0][0]).toEqual({})
		expect(valueCalls(self)).toEqual([])
	})
})

describe('routing variables keyed by id', () => {
	it('defines none for a device whose id has not arrived, and keys nothing on its name instead', () => {
		const self = instanceWithoutIds()
		UpdateVariableDefinitions(self)

		expect(definitionCalls(self)[0][0]).toEqual({})
	})

	it('keeps the same variable ids when a device is renamed', () => {
		const self = instance()
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		self.devicesData[STAGE].name = name('Stage Box B')
		self.deviceNamesById[STAGE_ID] = name('Stage Box B')
		CheckVariables(self, STAGE, 'tx_names')

		expect(valueCalls(self).at(-1)?.[0]).toEqual({ [`${STAGE_ID}_device_name`]: 'Stage Box B' })
	})
})

/**
 * `_connected` and `_status` say whether the subscription `_source` names is actually carrying
 * anything. `_source` follows what the receiver was asked for, so a refused or unresolved route
 * moves it all the same - these are what tell such a route from a working one.
 */
describe.each([
	{ mode: 'ids', amp: AMP_ID },
	{ mode: 'names', amp: 'Amp' },
])('subscription health variables keyed by $mode', ({ mode, amp }) => {
	const keyed = () => instance({ variableKeys: mode })

	/** Replaces one of Amp's receive channels, as a new rx directory reply would. */
	function setRx(self: DanteInstance, channel: 1 | 2, record: Omit<AudioRxChannel, 'number'>) {
		self.devicesData[AMP].audioRx![channel] = { number: ch(channel), ...record }
	}

	/** Every value published so far, the last one for each id winning - what the host now holds. */
	function published(self: DanteInstance): Record<string, unknown> {
		return Object.assign({}, ...valueCalls(self).map(([values]) => values))
	}

	it('reports a connected route as connected, with its status', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		expect(published(self)).toMatchObject({
			[`${amp}_rx_1_connected`]: true,
			[`${amp}_rx_1_status`]: 'connected (0x0009)',
		})
	})

	it('reports a refused self-route as not connected, saying why, while _source still names it', () => {
		const self = keyed()
		// as an Ultimo X2 reports a self-route it will not make: the '.' shorthand, status 0x001c
		setRx(self, 2, { name: 'Right', sourceDevice: '.', sourceChannel: 'Left', subscriptionStatus: 0x001c })
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		expect(published(self)).toMatchObject({
			[`${amp}_rx_2_source`]: 'Left@Amp',
			[`${amp}_rx_2_connected`]: false,
			[`${amp}_rx_2_status`]: 'unsupported (0x001c)',
		})
	})

	it('reports an unsubscribed channel as not connected, with an empty status', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)
		CheckVariables(self)
		// connect it, then clear it again, so '' is a value sent rather than the host's initial one
		setRx(self, 2, { name: 'Right', sourceDevice: 'Stage Box', sourceChannel: '02', subscriptionStatus: 9 })
		CheckVariables(self, AMP, 'rx')
		setRx(self, 2, { name: 'Right', subscriptionStatus: 0 })
		CheckVariables(self, AMP, 'rx')

		expect(valueCalls(self).at(-1)?.[0]).toEqual({
			[`${amp}_rx_2_source`]: '',
			[`${amp}_rx_2_source_id`]: '',
			[`${amp}_rx_2_connected`]: false,
			[`${amp}_rx_2_status`]: '',
		})
	})

	it('follows a pre-patched route to an offline source coming online, sending only that channel', () => {
		const self = keyed()
		// pre-patched: the receiver keeps the name and waits for a transmitter by it to appear
		setRx(self, 1, { name: 'Left', sourceDevice: 'Stage Box', sourceChannel: 'Mic 1', subscriptionStatus: 0x0001 })
		UpdateVariableDefinitions(self)
		CheckVariables(self)
		expect(published(self)).toMatchObject({
			[`${amp}_rx_1_connected`]: false,
			[`${amp}_rx_1_status`]: 'unresolved (0x0001)',
		})

		setRx(self, 1, { name: 'Left', sourceDevice: 'Stage Box', sourceChannel: 'Mic 1', subscriptionStatus: 0x0009 })
		CheckVariables(self, AMP, 'rx')

		// the source did not move, so neither did _source: just the two health values
		expect(valueCalls(self).at(-1)?.[0]).toEqual({
			[`${amp}_rx_1_connected`]: true,
			[`${amp}_rx_1_status`]: 'connected (0x0009)',
		})
		// a status change is a value change, never a definitions resend
		expect(definitionCalls(self)).toHaveLength(1)
	})

	it('reports a video subscription by its active flag', () => {
		const self = keyed()
		UpdateVariableDefinitions(self)
		CheckVariables(self)
		expect(published(self)).toMatchObject({
			[`${amp}_rx_video_1_connected`]: true,
			[`${amp}_rx_video_1_status`]: 'active',
		})

		// resolved, but the source sending nothing: Dante Controller's "Subscription is not active"
		self.devicesData[AMP].videoRx![1].subscriptionActive = 0
		CheckVariables(self, AMP, 'rx_video')
		expect(valueCalls(self).at(-1)?.[0]).toEqual({
			[`${amp}_rx_video_1_connected`]: false,
			[`${amp}_rx_video_1_status`]: 'not active',
		})

		self.devicesData[AMP].videoRx![1].subscriptionResolved = 0
		CheckVariables(self, AMP, 'rx_video')
		expect(valueCalls(self).at(-1)?.[0]).toEqual({ [`${amp}_rx_video_1_status`]: 'unresolved' })
	})
})

/**
 * An rx channel-query reply, as the device sends it in answer to a query - including the one the
 * module makes on each rx change notification, which is how a subscription's status reaches it.
 */
function rxReply(channels: { number: number; name: string; source?: string; channel?: string; status: number }[]) {
	const RECORD = 20
	const head = Buffer.alloc(12)
	const records = Buffer.alloc(RECORD * channels.length)
	const strings: Buffer[] = []
	let stringOffset = 12 + records.length
	const intern = (value: string | undefined): number => {
		if (!value) return 0
		const at = stringOffset
		const buffer = Buffer.from(`${value}\0`, 'ascii')
		strings.push(buffer)
		stringOffset += buffer.length
		return at
	}
	channels.forEach((channel, index) => {
		const base = index * RECORD
		records.writeUInt16BE(channel.number, base + 0)
		records.writeUInt16BE(1, base + 4)
		records.writeUInt16BE(intern(channel.channel), base + 6)
		records.writeUInt16BE(intern(channel.source), base + 8)
		records.writeUInt16BE(intern(channel.name), base + 10)
		records.writeUInt16BE(channel.status, base + 14)
	})
	const body = Buffer.concat([records, ...strings])
	head.writeUInt16BE(DANTE_CONST.PROTOCOL.CONTROL, 0)
	head.writeUInt16BE(12 + body.length, 2)
	head.writeUInt16BE(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY, 6)
	head.writeUInt8(channels.length, 11)
	return Buffer.concat([head, body])
}

describe('subscription health from the device', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('follows a status change in an rx reply, with no crosspoint action involved', () => {
		vi.useFakeTimers()
		const self = Object.assign(instance(), {
			counter: Buffer.from('0000', 'hex'),
			sockets: {},
			debug: false,
			checkFeedbacks: vi.fn(),
			checkFeedbacksById: vi.fn(),
			checkAllFeedbacks: vi.fn(),
			setActionDefinitions: vi.fn(),
			setFeedbackDefinitions: vi.fn(),
			setPresetDefinitions: vi.fn(),
		}) as DanteInstance
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		const deliver = (status: number) => {
			const reply = rxReply([
				{ number: 1, name: 'Left', source: 'Stage Box', channel: 'Mic 1', status },
				{ number: 2, name: 'Right', status: 0 },
			])
			parseReply(self, reply, { address: AMP, family: 'IPv4', port: 4440, size: reply.length })
			vi.advanceTimersByTime(1000)
		}

		// the transmitter went away: same subscription, now unresolved
		deliver(0x0001)
		expect(valueCalls(self).at(-1)?.[0]).toEqual({
			[`${AMP_ID}_rx_1_connected`]: false,
			[`${AMP_ID}_rx_1_status`]: 'unresolved (0x0001)',
		})

		// and back
		deliver(0x0009)
		expect(valueCalls(self).at(-1)?.[0]).toEqual({
			[`${AMP_ID}_rx_1_connected`]: true,
			[`${AMP_ID}_rx_1_status`]: 'connected (0x0009)',
		})
		cancelCheckVariables(self)
		cancelUpdateData(self)
	})
})
