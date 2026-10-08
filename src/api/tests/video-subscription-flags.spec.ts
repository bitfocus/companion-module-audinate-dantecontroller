import { describe, expect, it, vi } from 'vitest'
import { parseAvReply, isVideoSubscriptionActive, type DevicesData } from '../index.js'
import type DanteInstance from '../../main.js'

/**
 * The video subscription flags, against real captures.
 *
 * Taken from a live Encoder-001-0b52 / Decoder-001-0910 pair on 2026-09-10 by producing each state
 * deliberately and capturing the decoder's `0x3400` reply. Repeat captures of an unchanged state
 * were byte-identical, so every difference between these is signal.
 *
 * Two single-byte flags sit at record offsets +54 and +55: whether the named source has been
 * *resolved*, and whether media is actually *flowing*. Only the second answers "is this crosspoint
 * connected" - a subscription whose source is present but sending nothing reads "Subscription is
 * not active" in Dante Controller, and the module reported it as connected until these were found.
 *
 * A capture of the source being powered off is deliberately absent: it is byte-identical to the
 * idle one, so the decoder does not distinguish an idle source from an absent one and neither can
 * this module.
 */

/** Real capture: no subscription at all. */
const UNROUTED_HEX =
	'2809012810003400000100000000000003030030008400f00000bb8001010018040000180018000e4456433100303100161e00010000' +
	'0003000100000000000e0000000000280018000000000000002d00000000000000000001000006080000000000000000000002020000' +
	'4465636f64657220417564696f2052696768740030320000161e000200000003000200000000000e00000000006c0018000000000000' +
	'0080000000000000000000010000060800000000000000000000020200004465636f64657220566964656f204368616e6e656c003031' +
	'0000000002080000060000000000008500000000010100dc161c00030000000400010000000000060000000000c000dc000000000001' +
	'00d600010000000000ec00000000060600000000000000000000'

/** Real capture: subscribed to a device name that does not exist. */
const NEVER_RESOLVED_HEX =
	'2809014810003400000100000000000003030030008401100000bb8001010018040000180018000e4456433100303100161e00010000' +
	'0003000100000000000e0000000000280018000000000000002d00000000000000000001000006080000000000000000000002020000' +
	'4465636f64657220417564696f2052696768740030320000161e000200000003000200000000000e00000000006c0018000000000000' +
	'0080000000000000000000010000060800000000000000000000020200004e6f2053756368204368616e6e656c004e6f2d537563682d' +
	'4465766963652d58595a004465636f64657220566964656f204368616e6e656c00303100020800000600000000000085000000000101' +
	'00fc161c00030000000400010000000000060000000000e300fc00000000000100f9000100000000010c000000000606000000c000d0' +
	'00010000'

/** Real capture: resolved, source present, sending no video. */
const RESOLVED_IDLE_HEX =
	'2809015010003400000100000000000003030030008401180000bb8001010018040000180018000e4456433100303100161e00010000' +
	'0003000100000000000e0000000000280018000000000000002d00000000000000000001000006080000000000000000000002020000' +
	'4465636f64657220417564696f2052696768740030320000161e000200000003000200000000000e00000000006c0018000000000000' +
	'0080000000000000000000010000060800000000000000000000020200005472616e736d697420566964656f204368616e6e656c0045' +
	'6e636f6465722d3030312d30623532004465636f64657220566964656f204368616e6e656c0030310000000002080000060000000000' +
	'00850000000001010104161c00030000000400010000000000060000000000e8010400000000000100fe000100000000011400000000' +
	'0606000000c000d7000a0100'

/** Real capture: resolved, video flowing. */
const ACTIVE_HEX =
	'2809015010003400000100000000000003030030008401180000bb8001010018040000180018000e4456433100303100161e00010000' +
	'0003000100000000000e0000000000280018000000000000002d00000000000000000001000006080000000000000000000002020000' +
	'4465636f64657220417564696f2052696768740030320000161e000200000003000200000000000e00000000006c0018000000000000' +
	'0080000000000000000000010000060800000000000000000000020200005472616e736d697420566964656f204368616e6e656c0045' +
	'6e636f6465722d3030312d30623532004465636f64657220566964656f204368616e6e656c0030310000000002080000060000000000' +
	'00850000000001010104161c00030000000400010000000000060000000000e8010400000000000100fe000100000000011400000000' +
	'0606000000c000d7000a0101'

const DEVICE_IP = '169.254.2.58'

function instance(): DanteInstance {
	return {
		devicesData: { [DEVICE_IP]: { name: 'Decoder-001-0910', ports: { ARC: 4440 } } } as unknown as DevicesData,
		devicesChoices: [],
		rxChannelsChoices: {},
		txChannelsChoices: {},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		config: { variables: true, interval: 1000, timeoutInterval: 3000, verbose: false },
		debug: false,
		timeout: 3000,
		counter: Buffer.alloc(2),
		mac: Buffer.alloc(6),
		sockets: { ARC: { send: vi.fn() } },
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

/** Parses one capture and returns the decoder's single video receive channel. */
function videoChannel(hex: string) {
	const self = instance()
	const reply = Buffer.from(hex, 'hex')
	parseAvReply(self, reply, { address: DEVICE_IP, size: reply.length, port: 4440, family: 'IPv4' })
	return self.devicesData[DEVICE_IP]?.videoRx?.[1]
}

describe('video subscription flags, from real captures', () => {
	it('reports neither resolved nor active for an unrouted channel', () => {
		const channel = videoChannel(UNROUTED_HEX)
		expect(channel?.sourceDevice).toBeUndefined()
		expect(channel?.subscriptionResolved).toBe(0)
		expect(channel?.subscriptionActive).toBe(0)
	})

	it('reports a source but not resolved when the named device does not exist', () => {
		// the subscription is configured - the destination names it - but was never located
		const channel = videoChannel(NEVER_RESOLVED_HEX)
		expect(channel?.sourceDevice).toBe('No-Such-Device-XYZ')
		expect(channel?.subscriptionResolved).toBe(0)
		expect(channel?.subscriptionActive).toBe(0)
	})

	it('reports resolved but not active when the source is present and sending nothing', () => {
		const channel = videoChannel(RESOLVED_IDLE_HEX)
		expect(channel?.sourceDevice).toBe('Encoder-001-0b52')
		expect(channel?.sourceChannel).toBe('Transmit Video Channel')
		expect(channel?.subscriptionResolved).toBe(1)
		expect(channel?.subscriptionActive).toBe(0)
	})

	it('reports both resolved and active once video is flowing', () => {
		const channel = videoChannel(ACTIVE_HEX)
		expect(channel?.sourceDevice).toBe('Encoder-001-0b52')
		expect(channel?.subscriptionResolved).toBe(1)
		expect(channel?.subscriptionActive).toBe(1)
	})

	it('names the same source whether or not media is flowing', () => {
		// the two captures differ in exactly one byte, so nothing else may be read into the difference
		const idle = videoChannel(RESOLVED_IDLE_HEX)
		const active = videoChannel(ACTIVE_HEX)
		expect(idle?.sourceDevice).toBe(active?.sourceDevice)
		expect(idle?.sourceChannel).toBe(active?.sourceChannel)
		expect(idle?.name).toBe(active?.name)
	})

	it('treats only the flowing state as connected', () => {
		expect(isVideoSubscriptionActive(videoChannel(UNROUTED_HEX)?.subscriptionActive)).toBe(false)
		expect(isVideoSubscriptionActive(videoChannel(NEVER_RESOLVED_HEX)?.subscriptionActive)).toBe(false)
		expect(isVideoSubscriptionActive(videoChannel(RESOLVED_IDLE_HEX)?.subscriptionActive)).toBe(false)
		expect(isVideoSubscriptionActive(videoChannel(ACTIVE_HEX)?.subscriptionActive)).toBe(true)
	})

	it('does not read the flags off a transmit directory, where the offsets mean something else', () => {
		// parseVideoTxChannels takes only number and name from the very same records
		const self = instance()
		const reply = Buffer.from(ACTIVE_HEX, 'hex')
		parseAvReply(self, reply, {
			address: DEVICE_IP,
			size: reply.length,
			port: 4440,
			family: 'IPv4',
		})
		expect(self.devicesData[DEVICE_IP]?.videoTx).toBeUndefined()
	})
})
