import type dgram from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import {
	DANTE_CONST,
	danteDiscovery,
	makeAudioCrosspointConfirmed,
	notifyRxStateChanged,
	parseHeartbeatReply,
	type DevicesData,
	type MdnsResponsePacket,
} from '../api/index.js'
import type DanteInstance from '../main.js'
import { answeringSend } from './fake-device.js'
import { ch, id, ip, name } from './ids.js'

/**
 * Behaviour pinned to a real capture: Dante Controller routing two Ultimo X2 boards (IMAG-IO1 at
 * .237, IMAG-IO2 at .238), audio only.
 */

const IO1 = ip('192.168.1.237')
const IO2 = ip('192.168.1.238')

/** IMAG-IO2's heartbeat, as captured on 224.0.0.233:8708. */
const IO2_HEARTBEAT = Buffer.from(
	'fffe00ac0baa0000001dc1fffe843ea2417564696e617465000800011000000000108001000400040b6700000000000000248000000400040b67000000100000000100100006f1570007da420000000000000000001c8002000400100b670000000200000002000000180000c1c1c1c100208003000400140b67000000020000001800000000bb800000001000000000001c8004000400100b6700000002000000140000000000c200000000',
	'hex',
)

function instance(data: DevicesData = {}) {
	return {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: false, verbose: false },
		devicesData: data,
		devicesChoices: [],
		rxChannelsChoices: {},
		txChannelsChoices: {},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		deviceIdsByName: {},
		deviceNamesById: {},
		counter: Buffer.from('0100', 'hex'),
		debug: false,
		timeout: 0,
		mdns: { query: vi.fn() },
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkFeedbacksById: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

const rinfo = (address: string, size: number): dgram.RemoteInfo => ({ address, family: 'IPv4', port: 8700, size })

describe('capture dante4: device ids', () => {
	it('reads the device id a heartbeat carries', () => {
		const self = instance({ [IO2]: { name: name('IMAG-IO2'), ports: {} } })

		parseHeartbeatReply(self, IO2_HEARTBEAT, rinfo(IO2, IO2_HEARTBEAT.length))

		// the id the device's CMC TXT record and the probe report both carry
		expect(self.devicesData[IO2].id).toBe('001dc1fffe843ea2')
		expect(self.deviceIdsByName).toEqual({ 'IMAG-IO2': '001dc1fffe843ea2' })
	})

	it('does not read a heartbeat from a device not yet named', () => {
		const self = instance({ [IO2]: { ports: {} } })
		parseHeartbeatReply(self, IO2_HEARTBEAT, rinfo(IO2, IO2_HEARTBEAT.length))
		expect(self.devicesData[IO2].id).toBeUndefined()
	})

	it("never reads a channel record's id - which is a transmit channel number - as a device id", () => {
		// A receiver resolving "01 n/a@IMAG-IO1" asks for it by name; the transmitter answers with its
		// channel number as `id`. These answers reach the module too.
		const self = instance({ [IO1]: { name: name('IMAG-IO1'), ports: {} } })
		const response: MdnsResponsePacket = {
			answers: [],
			additionals: [
				{
					type: 'TXT',
					name: '01 n/a@IMAG-IO1._netaudio-chan._udp.local',
					data: [Buffer.from('txtvers=2'), Buffer.from('id=1'), Buffer.from('nchan=2')],
				},
			],
		}

		danteDiscovery(self, response, rinfo(IO1, 0))

		expect(self.devicesData[IO1].id).toBeUndefined()
		expect(self.deviceIdsByName).toEqual({})
	})
})

describe('capture dante4: confirming a route that needs a new flow', () => {
	it('waits through the connecting status the device reports while the flow comes up', async () => {
		const io1Id = id(0x844236)
		const io2Id = id(0x843ea2)
		const self = instance({
			[IO1]: {
				name: name('IMAG-IO1'),
				id: io1Id,
				ports: { ARC: 4440 },
				audioRx: {
					count: 2,
					1: { number: ch(1), name: '01 IMAG-MIX-XLR-L' },
					2: { number: ch(2), name: '02 IMAG-MIX-XLR-R' },
				},
			},
			[IO2]: {
				name: name('IMAG-IO2'),
				id: io2Id,
				ports: { ARC: 4440 },
				audioTx: {
					count: 2,
					1: { number: ch(1), name: '01 IMAG-LTC-XLR-LOCALBACKUP' },
					2: { number: ch(2), name: '02 n/a' },
				},
			},
		})
		// As captured: subscribed at once with status 0x0001 and receiver status 0, then connected
		// (0x0009) about 150 ms later, which the device announces with a second notification pair.
		const send = answeringSend(self, (command) =>
			command.readUInt16BE(6) === DANTE_CONST.COMMANDS.subscription
				? {
						apply: () => {
							const subscribed = {
								number: ch(2),
								name: '02 IMAG-MIX-XLR-R',
								sourceDevice: 'IMAG-IO2',
								sourceChannel: '02 n/a',
							}
							self.devicesData[IO1].audioRx![2] = { ...subscribed, subscriptionStatus: 0x0001, channelStatus: 0x0000 }
							setTimeout(() => {
								self.devicesData[IO1].audioRx![2] = { ...subscribed, subscriptionStatus: 0x0009, channelStatus: 0x0101 }
								notifyRxStateChanged(self, IO1)
							}, 150)
						},
					}
				: undefined,
		)
		self.sockets = { ARC: { send } as unknown as dgram.Socket }

		const started = Date.now()
		await makeAudioCrosspointConfirmed(self, io1Id, '02 n/a', 'IMAG-IO2', 2)

		// resolved on the notification, not a later poll
		expect(Date.now() - started).toBeLessThan(400)
	})
})
