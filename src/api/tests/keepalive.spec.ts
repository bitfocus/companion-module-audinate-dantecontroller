import { describe, expect, it, vi } from 'vitest'
import {
	parseAvReply,
	parseCmcReply,
	parseHeartbeatReply,
	parseReply,
	parseSettingsReply,
	type DevicesData,
} from '../index.js'
import type dgram from 'node:dgram'
import type DanteInstance from '../../main.js'

/**
 * Any reply from a device must count as proof it is online.
 *
 * Only an mDNS SRV answer and a HEARTBEAT multicast packet used to re-arm a device's offline timer.
 * A device answering ARC, AV, SETTINGS and CMC queries - demonstrably mid-conversation with this
 * module - could therefore still be declared offline and destroyed, because three polls' worth of
 * discovery replies were dropped or because it emits no heartbeats. Destroying it deletes its
 * channel choices, which removes its per-device option fields from every action and feedback: a
 * configured video channel stops resolving until the device is rediscovered *and* re-queried.
 */

const IP = '172.16.3.142'
const NAME = 'DAV-01SR-1001c7'

/** Real captures, so these are the replies a device actually sends. */
const REPLIES: Record<string, { hex: string; parse: Parser }> = {
	'an ARC reply': { hex: '2729001c000b20000001020000000000000000000000000000000000', parse: parseReply },
	// a real video tx directory reply - AV_EXTENDED is 0x28xx, not the 0x2729 CONTROL marker
	'an AV_EXTENDED reply': {
		hex:
			'28090108110b2400000100000000000003030040008400dc0000bb8001010018040000180018000e5472616e736d69742041756469' +
			'6f204c6566740030310000161600010000000300010000000001070000000000280018000000000000003c00000000000000000001' +
			'00005472616e736d697420417564696f205269676874003032001616000200000003000200000000010700000000006c0018000000' +
			'0000000081000000000000000000010000020800000600000000000085000000005472616e736d697420566964656f204368616e6e' +
			'656c003031000000161600030000000400010000000000070000000000c000b000000000000100d7000000000000000000000000',
		parse: parseAvReply,
	},
	'a SETTINGS reply': {
		hex: 'ffff0034051f0000001dc1fffe2c87d6417564696e617465073d008000000000001800010000bb800000bb80000100000000bb80',
		parse: parseSettingsReply,
	},
	'a CMC reply': {
		hex: '120000280010100100010000001dc1fffe2c87d600020000a9fe78b721fc0000ac1f78b821fc0000',
		parse: parseCmcReply,
	},
	'a heartbeat': {
		hex:
			'fffe005426900000001dc1fffe2c87d6417564696e617465000800011000000000348000000400040cd000000010000000020010' +
			'0005b0c100000ad00000000000000000000007d6000000000000000000000000',
		parse: parseHeartbeatReply,
	},
}

type Parser = (self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo) => void

function instance(): DanteInstance {
	return {
		devicesData: {
			[IP]: { name: NAME, ports: { ARC: 4440, CMC: 8800 }, timeoutArray: [setTimeout(() => {}, 3000)] },
		} as unknown as DevicesData,
		devicesChoices: [{ id: NAME, label: NAME }],
		rxChannelsChoices: {},
		txChannelsChoices: {},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		debug: false,
		timeout: 3000,
		counter: Buffer.alloc(2),
		mac: Buffer.alloc(6),
		sockets: { ARC: { send: vi.fn() }, SETTINGS: { send: vi.fn() } },
		connection: { noteTraffic: vi.fn() },
		checkFeedbacksById: vi.fn(),
		checkAllFeedbacks: vi.fn(),
		setVariableValues: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		log: vi.fn(),
		updateStatus: vi.fn(),
	} as unknown as DanteInstance
}

function rinfo(size: number): dgram.RemoteInfo {
	return { address: IP, size, port: 4440, family: 'IPv4' }
}

describe.each(Object.entries(REPLIES))('%s keeps the device online', (_label, { hex, parse }) => {
	it('replaces the pending offline timer, so the device is not destroyed mid-conversation', () => {
		vi.useFakeTimers()
		try {
			const self = instance()
			const before = self.devicesData[IP].timeoutArray?.[0]
			const reply = Buffer.from(hex, 'hex')

			parse(self, reply, rinfo(reply.length))

			const after = self.devicesData[IP].timeoutArray?.[0]
			expect(after).toBeDefined()
			// keepAlive clears the old timer and arms a fresh one - a different handle
			expect(after).not.toBe(before)
		} finally {
			vi.useRealTimers()
		}
	})

	it('carries the device past its offline timeout while replies keep arriving', () => {
		vi.useFakeTimers()
		try {
			const self = instance()
			const reply = Buffer.from(hex, 'hex')

			// a reply a second, across four times the 3s timeout
			for (let i = 0; i < 12; i++) {
				parse(self, reply, rinfo(reply.length))
				vi.advanceTimersByTime(1000)
			}

			expect(self.devicesData[IP], 'the device was destroyed while it was still answering').toBeDefined()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('an unregistered device is still ignored', () => {
	it('does not arm a timer for a device discovery has never seen', () => {
		// mDNS discovery stays the source of truth for a device's existence - a reply must not be
		// able to stub one in, which is what the registration guards these calls sit behind are for
		const self = instance()
		delete self.devicesData[IP]
		const reply = Buffer.from(REPLIES['an ARC reply'].hex, 'hex')

		parseReply(self, reply, rinfo(reply.length))
		expect(self.devicesData[IP]).toBeUndefined()
	})
})
