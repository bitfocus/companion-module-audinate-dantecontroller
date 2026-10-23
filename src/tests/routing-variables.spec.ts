import { describe, expect, it, vi } from 'vitest'
import { danteDiscovery, danteDeviceIdFromTxt, type DevicesData, type MdnsResponsePacket } from '../api/index.js'
import type DanteInstance from '../main.js'
import { VariablePublisher } from '../variable-publisher.js'
import { CheckVariables, UpdateVariableDefinitions } from '../variables.js'

const STAGE = '10.0.0.5'
const AMP = '10.0.0.6'

function devicesData(): DevicesData {
	return {
		[STAGE]: {
			name: 'Stage Box',
			ports: { ARC: 4440 },
			audioTx: { count: 2, 1: { number: 1, name: '01', friendlyName: 'Mic 1' }, 2: { number: 2, name: '02' } },
			audioRx: { count: 0 },
		},
		[AMP]: {
			name: 'Amp',
			ports: { ARC: 4440 },
			audioRx: {
				count: 2,
				1: { number: 1, name: 'Left', sourceDevice: 'Stage Box', sourceChannel: 'Mic 1', subscriptionStatus: 9 },
				2: { number: 2, name: 'Right' },
			},
			videoRx: { count: 1, 1: { number: 1, name: 'HDMI', sourceDevice: 'Encoder', sourceChannel: 'Cam' } },
		},
	}
}

function instance(config: Record<string, unknown> = {}) {
	return {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: false, verbose: false, ...config },
		devicesData: devicesData(),
		devicesChoices: [
			{ id: 'Amp', label: 'Amp' },
			{ id: 'Stage Box', label: 'Stage Box' },
		],
		rxChannelsChoices: {
			Amp: [
				{ id: 1, label: 'Left' },
				{ id: 2, label: 'Right' },
			],
		},
		txChannelsChoices: {
			'Stage Box': [
				{ id: 1, label: 'Mic 1' },
				{ id: 2, label: '02' },
			],
		},
		videoRxChannelsChoices: { Amp: [{ id: 1, label: 'HDMI' }] },
		videoTxChannelsChoices: {},
		deviceIdsByName: { Amp: '001dc1fffe0a1b2c' },
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
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

	it('records the id from a CMC TXT answer and asks for it with the SRV record', () => {
		const self = instance()
		;(self as unknown as { mdns: { query: ReturnType<typeof vi.fn> } }).mdns = { query: vi.fn() }
		const response: MdnsResponsePacket = {
			answers: [{ type: 'PTR', name: '_netaudio-cmc._udp.local', data: 'Stage Box._netaudio-cmc._udp.local' }],
			additionals: [
				{ type: 'TXT', name: 'Stage Box._netaudio-cmc._udp.local', data: [Buffer.from('id=001dc1fffe0a9999')] },
				// an ARC TXT record carries no device id and must not be read as one
				{ type: 'TXT', name: 'Amp._netaudio-arc._udp.local', data: [Buffer.from('id=ffffffffffffffff')] },
			],
		}

		danteDiscovery(self, response, { address: STAGE, family: 'IPv4', port: 5353, size: 0 })

		expect(self.deviceIdsByName).toEqual({ Amp: '001dc1fffe0a1b2c', 'Stage Box': '001dc1fffe0a9999' })
		const query = (self.mdns.query as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(query.questions).toEqual([
			{ name: 'Stage Box._netaudio-cmc._udp.local', type: 'SRV' },
			{ name: 'Stage Box._netaudio-cmc._udp.local', type: 'TXT' },
		])
	})
})

describe('routing variables', () => {
	it('defines one variable per channel and one id per device', () => {
		const self = instance()
		UpdateVariableDefinitions(self)

		expect(Object.keys(definitionCalls(self)[0][0]).sort()).toEqual([
			'Amp_device_id',
			'Amp_rx_1_name',
			'Amp_rx_1_source',
			'Amp_rx_1_source_id',
			'Amp_rx_2_name',
			'Amp_rx_2_source',
			'Amp_rx_2_source_id',
			'Amp_rx_video_1_name',
			'Amp_rx_video_1_source',
			'Amp_rx_video_1_source_id',
			'Stage_Box_device_id',
			'Stage_Box_tx_1_name',
			'Stage_Box_tx_2_name',
		])
	})

	it('publishes sources as channel@device and transmit names as their subscription names', () => {
		const self = instance()
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		expect(valueCalls(self)[0][0]).toEqual({
			Amp_device_id: '001dc1fffe0a1b2c',
			Amp_rx_1_name: 'Left',
			Amp_rx_1_source: 'Mic 1@Stage Box',
			Amp_rx_2_name: 'Right',
			Amp_rx_video_1_name: 'HDMI',
			Amp_rx_video_1_source: 'Cam@Encoder',
			Stage_Box_tx_1_name: 'Mic 1',
			Stage_Box_tx_2_name: '02',
		})
	})

	it('sends one value when one subscription changes', () => {
		const self = instance()
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		self.devicesData[AMP].audioRx![2] = {
			number: 2,
			name: 'Right',
			sourceDevice: 'Stage Box',
			sourceChannel: '02',
			subscriptionStatus: 9,
		}
		CheckVariables(self, AMP, 'rx')

		expect(valueCalls(self)[1][0]).toEqual({ Amp_rx_2_source: '02@Stage Box' })
	})

	it('does not re-send definitions when only a channel is renamed', () => {
		const self = instance()
		UpdateVariableDefinitions(self)
		self.rxChannelsChoices.Amp[0] = { id: 1, label: 'Left (FOH)' }
		self.devicesData[AMP].audioRx![1].name = 'Left (FOH)'
		UpdateVariableDefinitions(self)
		CheckVariables(self, AMP, 'rx_names')

		expect(definitionCalls(self)).toHaveLength(1)
		expect(valueCalls(self).at(-1)?.[0]).toMatchObject({ Amp_rx_1_name: 'Left (FOH)' })
	})

	it('is skipped for categories that cannot change it', () => {
		const self = instance()
		UpdateVariableDefinitions(self)
		CheckVariables(self)
		CheckVariables(self, AMP, 'latency')

		expect(valueCalls(self)).toHaveLength(1)
	})

	it('can be turned off', () => {
		const self = instance({ routingVariables: false })
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		expect(definitionCalls(self)[0][0]).toEqual({})
		expect(valueCalls(self)).toEqual([])
	})
})
