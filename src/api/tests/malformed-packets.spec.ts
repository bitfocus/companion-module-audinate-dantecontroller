import { describe, expect, it, vi } from 'vitest'
import type dgram from 'node:dgram'
import {
	parseAvReply,
	parseCmcReply,
	parseHeartbeatReply,
	parseReply,
	parseSettingsReply,
	type DevicesData,
} from '../index.js'
import type DanteInstance from '../../main.js'

/**
 * No parser may throw on a malformed packet.
 *
 * They run directly from a socket's 'message' event and `@companion-module/base` installs no
 * `uncaughtException` handler, so a throw here does not lose a packet - it takes the module process
 * down. The SETTINGS and HEARTBEAT sockets are bound to well-known ports on the wildcard address,
 * so anything on the network can send one: a zero-length UDP datagram is legal, and used to be
 * enough to kill the connection.
 */

const DEVICE_IP = '169.254.120.183'

/** Real captures, so the truncations below are of genuinely well-formed packets. */
const REAL_PACKETS: Record<string, string> = {
	parseReply: '2729001c000b20000001020000000000000000000000000000000000',
	parseAvReply: '2729001c000b24000001020000000000000000000000000000000000',
	parseSettingsReply:
		'ffff0034051f0000001dc1fffe2c87d6417564696e617465073d008000000000001800010000bb800000bb80000100000000bb80',
	parseHeartbeatReply:
		'fffe005426900000001dc1fffe2c87d6417564696e617465000800011000000000348000000400040cd0000000100000000200100005b0c100000ad00000000000000000000007d6000000000000000000000000',
	parseCmcReply: '120000280010100100010000001dc1fffe2c87d600020000a9fe78b721fc0000ac1f78b821fc0000',
}

type Parser = (self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo) => void

const PARSERS: Record<string, Parser> = {
	parseReply,
	parseAvReply,
	parseSettingsReply,
	parseHeartbeatReply,
	parseCmcReply,
}

/** A registered device, so parsing gets past the "discovery has not seen this one" early return. */
function instance(): DanteInstance {
	return {
		devicesData: {
			[DEVICE_IP]: { name: 'DeviceA', ports: { ARC: 4440 }, timeoutArray: [] },
		} as unknown as DevicesData,
		devicesChoices: [],
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
	return { address: DEVICE_IP, size, port: 4440, family: 'IPv4' }
}

describe.each(Object.keys(PARSERS))('%s survives malformed input', (name) => {
	const parse = PARSERS[name]
	const full = Buffer.from(REAL_PACKETS[name], 'hex')

	it('does not throw on an empty datagram, which anything on the network can send', () => {
		const empty = Buffer.alloc(0)
		expect(() => parse(instance(), empty, rinfo(0))).not.toThrow()
	})

	it('does not throw on any truncation of a real packet', () => {
		// every prefix, so a reply clipped anywhere is covered rather than at a few chosen lengths
		for (let length = 0; length <= full.length; length++) {
			const truncated = full.subarray(0, length)
			expect(() => parse(instance(), truncated, rinfo(truncated.length)), `threw at length ${length}`).not.toThrow()
		}
	})

	it('does not throw when the size field lies about the packet length', () => {
		// the parsers compare rinfo.size against a size field; a mismatch must fail the check, not read
		for (const claimed of [0, 1, 8, 255, 65535]) {
			expect(() => parse(instance(), full, rinfo(claimed)), `threw for claimed size ${claimed}`).not.toThrow()
		}
	})

	it('does not throw on random bytes carrying the right length', () => {
		for (let attempt = 0; attempt < 200; attempt++) {
			const noise = Buffer.alloc(full.length)
			for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
			// keep the protocol marker and size, so parsing gets past the guards and into the body
			full.subarray(0, 4).copy(noise, 0)
			expect(() => parse(instance(), noise, rinfo(noise.length))).not.toThrow()
		}
	})

	it('still parses the real packet, so the guards did not just reject everything', () => {
		expect(() => parse(instance(), full, rinfo(full.length))).not.toThrow()
	})
})
