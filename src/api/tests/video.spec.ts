import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { LoggingSink } from '@companion-module/base'
import type dgram from 'node:dgram'
import {
	makeAvCommand,
	makeVideoCrosspoint,
	clearVideoCrosspoint,
	setVideoRxChannelName,
	setVideoTxChannelName,
	parseAvReply,
	getVideoRxChannels,
	getVideoTxChannels,
	getVideoRxChannelSource,
	findVideoRxChannelByName,
	findVideoTxChannelByName,
	DANTE_CONST,
	type DevicesData,
} from '../index.js'
import type DanteInstance from '../../main.js'

/**
 * Real packets captured from a live Dante network during the video-routing reverse-engineering
 * session (see the `dante-video-routing-protocol` project notes), used to check both the command
 * builders and the reply parser against genuine wire data rather than only hand-built buffers.
 *
 * `AV_EXTENDED`'s low protocol byte varies per controlling-application session (this module always
 * sends `0x2809`; these captures show `0x2809` and `0x280c` from two different sessions) - the
 * comparisons below normalize the protocol and counter bytes out rather than assert on them.
 */
const REAL_VIDEO_SUBSCRIBE_HEX =
	'2809003a0058341000000000000000000800030100010004002c002f000000000000000000000000000000003031004441562d31313062353200'
const REAL_VIDEO_CLEAR_HEX = '2809002c00513410000000000000000008000301000100040000000000000000000000000000000000000000'
const REAL_VIDEO_RX_RENAME_HEX = [
	'280c',
	'003c',
	'01e5',
	'3401',
	'0000',
	'0000',
	'0000',
	'0000',
	'0600',
	'0301',
	'0001',
	'0004',
	'0026',
	'0000',
	'0000',
	'0000',
	'0000',
	'0000',
	'0000',
	'4465',
	'636f',
	'6465',
	'7220',
	'5669',
	'6465',
	'6f20',
	'4368',
	'616e',
	'6e65',
	'6c00',
].join('')
const REAL_VIDEO_TX_RENAME_HEX =
	[
		'280c',
		'003d',
		'01cd',
		'2438',
		'0000',
		'0000',
		'0000',
		'0000',
		'0600',
		'0301',
		'0001',
		'0004',
		'0026',
		'0000',
		'0000',
		'0000',
		'0000',
		'0000',
		'0000',
		'5472',
		'616e',
		'736d',
		'6974',
		'2056',
		'6964',
		'656f',
		'2043',
		'6861',
		'6e6e',
		'656c',
	].join('') + '00'

/**
 * A real `MESSAGE_TYPE_AV_RX_CHANNEL_QUERY` reply (384 bytes), captured with all three of a
 * device's channels (one video, two audio) live-routed. Confirmed by diffing against
 * `REAL_VIDEO_ALL_CLEARED_HEX` (an otherwise byte-identical reply captured moments after a
 * batch-clear) that only the source-name pointers move between the two.
 */
const REAL_VIDEO_ALL_ROUTED_HEX =
	'280c01800215340000010000000000000303006000c801485472616e736d697420417564696f204c65667400456e636f6465722d303031000000bb8001010018040000180018000e4465636f64657220417564696f204c656674003031000000161e000100000003000100000000000e0000000000480038000000000000005b000000000000000000010000060800000018002c00010000020200005472616e736d697420417564696f205269676874004465636f64657220417564696f20526967687400303200161e000200000003000200000000000e0000000000b1003800000000000000c500000000000000000001000006080000009c002c00010000020200005472616e736d697420566964656f204368616e6e656c004465636f64657220566964656f204368616e6e656c003031000208000006000000000000850000000001010134161c000300000004000100000000000600000000011b01340000000000010131000100000000014400000000060600000104002c00010000'

/** As {@link REAL_VIDEO_ALL_ROUTED_HEX}, captured immediately after a batch-clear of all 3 channels. */
const REAL_VIDEO_ALL_CLEARED_HEX =
	'280c013802213400000100000000000003030040009401000000bb8001010018040000180018000e4465636f64657220417564696f204c656674003031000000161e000100000003000100000000000e0000000000280018000000000000003b000000000000000000010000060800000000000000000000020200004465636f64657220417564696f2052696768740030320000161e000200000003000200000000000e00000000007c00180000000000000090000000000000000000010000060800000000000000000000020200004465636f64657220566964656f204368616e6e656c0030310000000002080000060000000000008500000000010100ec161c00030000000400010000000000060000000000d000ec00000000000100e600010000000000fc00000000060600000000000000000000'

/**
 * A real `MESSAGE_TYPE_AV_TX_CHANNEL_QUERY` (`0x2400`) reply from an encoder (TAV-CHAZYUSB-TX),
 * listing its three transmit channels - two audio then one video.
 *
 * The regression this pins down: every record here carries the tag `0x1616`, for *both* the audio
 * and the video records. An earlier parser matched records on that tag against the rx directory's
 * `0x161c` (video), so this reply decoded as zero video channels and the encoder never offered a
 * video source anywhere in the UI. The media type at record offset +6 is what actually
 * distinguishes them.
 */
const REAL_VIDEO_TX_DIRECTORY_HEX =
	'28090108110b2400000100000000000003030040008400dc0000bb8001010018040000180018000e5472616e736d697420417564696f204c6566740030310000161600010000000300010000000001070000000000280018000000000000003c0000000000000000000100005472616e736d697420417564696f205269676874003032001616000200000003000200000000010700000000006c00180000000000000081000000000000000000010000020800000600000000000085000000005472616e736d697420566964656f204368616e6e656c003031000000161600030000000400010000000000070000000000c000b000000000000100d7000000000000000000000000'

/**
 * A real `0x2400` reply from a device with transmit channels but no *video* transmit channels (the
 * decoder, which sends two audio channels back). Its records use the same `0x1616` tag as the
 * encoder's, so nothing but the media type tells them apart.
 */
const REAL_AUDIO_ONLY_TX_DIRECTORY_HEX =
	'280900b8110c2400000100000000000002020044008c00000000bb8001010018040000180018000e4465636f64657220417564696f204c65667420547800303100000000161600010000000300010000000001070000000000280018000000000000003e0000000000000000000100004465636f64657220417564696f2052696768742054780030320000001616000200000003000200000000010700000000007000180000000000000087000000000000000000010000'

/**
 * A real `0x2400` reply from a plain audio-only Dante board (TAV-MINEOLA22XLR), whose records carry
 * a different tag again - `0x1414`. Kept as a third tag value proving the tag is a device/reply
 * trait rather than a media-type marker.
 */
const REAL_LEGACY_TAG_TX_DIRECTORY_HEX =
	'28090080110d240000010000000000000202002c005800000000bb8001010018040000180018000e43483100141400010000000300010000000001070000000000280018000000000000002800000000000000004348320014140002000000030002000000000107000000000054001800000000000000540000000000000000'

const REAL_DEVICE_IP = '169.254.2.58'

let loggerSink: ReturnType<typeof vi.fn<LoggingSink>>

beforeEach(() => {
	loggerSink = vi.fn<LoggingSink>()
	global.COMPANION_LOGGER = loggerSink
})

afterEach(() => {
	global.COMPANION_LOGGER = undefined
})

function makeRinfo(address: string, size: number): dgram.RemoteInfo {
	return { address, size, port: 0, family: 'IPv4' }
}

function createMockInstance(overrides: Partial<DanteInstance> & { devicesData?: DevicesData } = {}): DanteInstance {
	const base = {
		devicesData: {},
		sockets: {},
		counter: Buffer.from('0000', 'hex'),
		debug: false,
		log: vi.fn(),
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		setVariableValues: vi.fn(),
		checkFeedbacksById: vi.fn(),
		checkAllFeedbacks: vi.fn(),
		...overrides,
	}
	return base as unknown as DanteInstance
}

/** Zeroes the protocol (bytes 0-1) and counter (bytes 4-5) fields, so a built command can be
 * compared against a real capture from a different session/counter without those expected
 * differences failing the comparison. */
function normalized(buffer: Buffer): string {
	const copy = Buffer.from(buffer)
	copy.writeUInt16BE(0, 0)
	copy.writeUInt16BE(0, 4)
	return copy.toString('hex')
}

/**
 * The opcodes of the queries a write command issued after itself.
 *
 * Every video write re-reads the affected directory, because AV_EXTENDED devices send no unsolicited
 * update when routing or names change - see `refreshVideoChannels` in `commands.ts`.
 */
function followUpQueryOpcodes(send: ReturnType<typeof vi.fn>): number[] {
	return send.mock.calls.slice(1).map((call) => (call[0] as Buffer).readUInt16BE(6))
}

describe('makeAvCommand', () => {
	it('builds a command with the AV_EXTENDED protocol marker and increments the counter', () => {
		const self = createMockInstance({ counter: Buffer.from('0000', 'hex') })
		const buf = makeAvCommand(self, 0x3400)
		expect(buf.readUInt16BE(0)).toBe(DANTE_CONST.PROTOCOL.AV_EXTENDED)
		expect(buf.readUInt16BE(2)).toBe(buf.length) // length field matches the actual payload size
		expect(buf.readUInt16BE(6)).toBe(0x3400) // commandType
		expect(self.counter).toEqual(Buffer.from('0001', 'hex'))
	})

	it('includes the given command arguments in the payload', () => {
		const self = createMockInstance()
		const args = Buffer.from('deadbeef', 'hex')
		const buf = makeAvCommand(self, 0x3400, args)
		expect(buf.subarray(10, 14)).toEqual(args)
	})
})

describe('getVideoRxChannels / getVideoTxChannels', () => {
	// An empty-argument query is acknowledged by real hardware but always reports zero records, even
	// from a device with real channels - confirmed live against a TAV-CHAZY4K-RX decoder. These
	// specific bytes are what elicits the actual multi-record directory.
	it('sends the required query argument bytes, not an empty argument buffer', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})

		getVideoRxChannels(self, REAL_DEVICE_IP)
		getVideoTxChannels(self, REAL_DEVICE_IP)

		expect(send).toHaveBeenCalledTimes(2)
		const [rxSent, txSent] = send.mock.calls.map((call) => call[0] as Buffer)

		expect(rxSent.readUInt16BE(6)).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY)
		expect(rxSent.subarray(10)).toEqual(DANTE_CONST.AV_CHANNEL_DIRECTORY_QUERY_ARGS)

		expect(txSent.readUInt16BE(6)).toBe(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY)
		expect(txSent.subarray(10)).toEqual(DANTE_CONST.AV_CHANNEL_DIRECTORY_QUERY_ARGS)
	})

	// Asserted as literals, not against the constants the implementation reads: the point is to catch
	// the opcodes being changed, which comparing a constant to itself cannot do. 0x2600 in particular
	// looks like the tx directory and is not - it answers with the device's outbound flows.
	it('uses the confirmed directory opcodes - 0x3400 for rx, 0x2400 (not 0x2600) for tx', () => {
		expect(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY).toBe(0x3400)
		expect(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY).toBe(0x2400)
	})
})

describe('makeVideoCrosspoint / clearVideoCrosspoint', () => {
	it('logs an error and sends nothing when the destination device cannot be resolved', () => {
		const send = vi.fn()
		const self = createMockInstance({ sockets: { ARC: { send } as unknown as dgram.Socket } })
		makeVideoCrosspoint(self, 'UnknownDevice', '01', 'Encoder-001', 1)
		expect(send).not.toHaveBeenCalled()
		expect(loggerSink).toHaveBeenCalledWith('api:commands', 'error', expect.stringContaining("Can't find"))
	})

	it('reproduces a real captured subscribe command byte-for-byte, mod protocol and counter', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		makeVideoCrosspoint(self, REAL_DEVICE_IP, '01', 'DAV-110b52', 1)
		const sent = send.mock.calls[0][0] as Buffer
		expect(normalized(sent)).toBe(normalized(Buffer.from(REAL_VIDEO_SUBSCRIBE_HEX, 'hex')))
		expect(followUpQueryOpcodes(send)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY])
	})

	it('reproduces a real captured clear command byte-for-byte, mod protocol and counter', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		clearVideoCrosspoint(self, REAL_DEVICE_IP, 1)
		const sent = send.mock.calls[0][0] as Buffer
		expect(normalized(sent)).toBe(normalized(Buffer.from(REAL_VIDEO_CLEAR_HEX, 'hex')))
		expect(followUpQueryOpcodes(send)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY])
	})

	it('rejects channel 0, same as the audio crosspoint commands', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		makeVideoCrosspoint(self, REAL_DEVICE_IP, '01', 'DAV-110b52', 0)
		expect(send).not.toHaveBeenCalled()
		clearVideoCrosspoint(self, REAL_DEVICE_IP, 0)
		expect(send).not.toHaveBeenCalled()
	})
})

describe('setVideoRxChannelName / setVideoTxChannelName', () => {
	it('reproduces a real captured rx rename command byte-for-byte, mod protocol and counter', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		setVideoRxChannelName(self, REAL_DEVICE_IP, 1, 'Decoder Video Channel')
		const sent = send.mock.calls[0][0] as Buffer
		expect(normalized(sent)).toBe(normalized(Buffer.from(REAL_VIDEO_RX_RENAME_HEX, 'hex')))
		expect(followUpQueryOpcodes(send)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY])
	})

	it('reproduces a real captured tx rename command byte-for-byte, mod protocol and counter', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110b52', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		setVideoTxChannelName(self, REAL_DEVICE_IP, 1, 'Transmit Video Channel')
		const sent = send.mock.calls[0][0] as Buffer
		expect(normalized(sent)).toBe(normalized(Buffer.from(REAL_VIDEO_TX_RENAME_HEX, 'hex')))
		// a tx rename re-reads the *tx* directory, not the rx one
		expect(followUpQueryOpcodes(send)).toEqual([DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY])
	})

	it('rejects an invalid name and sends nothing', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		setVideoRxChannelName(self, REAL_DEVICE_IP, 1, 'bad!name')
		expect(send).not.toHaveBeenCalled()
	})
})

describe('parseAvReply', () => {
	it('ignores traffic from a device that has not been discovered yet', () => {
		const self = createMockInstance({ devicesData: {} })
		const reply = Buffer.from(REAL_VIDEO_ALL_ROUTED_HEX, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))
		expect(self.devicesData[REAL_DEVICE_IP]).toBeUndefined()
	})

	it('ignores CONTROL-protocol traffic on the same socket', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910' } } })
		const reply = Buffer.from('2729001c000b20000001020000000000000000000000000000000000', 'hex')
		expect(() => parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))).not.toThrow()
		expect(self.devicesData[REAL_DEVICE_IP]?.videoRx).toBeUndefined()
	})

	it('parses a real rx channel-directory reply into videoRx, with live source names', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910' } } })
		const reply = Buffer.from(REAL_VIDEO_ALL_ROUTED_HEX, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))

		const videoRx = self.devicesData[REAL_DEVICE_IP]?.videoRx
		expect(videoRx?.count).toBe(1)
		expect(videoRx?.[1]).toEqual({
			number: 1,
			name: 'Decoder Video Channel',
			sourceChannel: 'Transmit Video Channel',
			sourceDevice: 'Encoder-001',
		})
	})

	it('numbers a channel by its own media type, not its position across all channels', () => {
		// The video record sits third in the combined list and its position field says so, but a
		// crosspoint command addresses it as video channel 1 - the number at record offset +8.
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910' } } })
		const reply = Buffer.from(REAL_VIDEO_ALL_ROUTED_HEX, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))

		const videoRx = self.devicesData[REAL_DEVICE_IP]?.videoRx
		expect(videoRx?.[1]?.number).toBe(1)
		expect(videoRx?.[3]).toBeUndefined()
	})

	it('parses a real tx channel-directory reply into videoTx, ignoring its audio channels', () => {
		// Every record in this capture carries tag 0x1616, audio and video alike - matching on the
		// rx directory's 0x161c video tag found nothing here and left encoders with no video source.
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'Encoder-001' } } })
		const reply = Buffer.from(REAL_VIDEO_TX_DIRECTORY_HEX, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))

		const videoTx = self.devicesData[REAL_DEVICE_IP]?.videoTx
		expect(videoTx?.count).toBe(1)
		expect(videoTx?.[1]).toEqual({ number: 1, name: 'Transmit Video Channel' })
	})

	it.each([
		['a device whose transmit channels are all audio', REAL_AUDIO_ONLY_TX_DIRECTORY_HEX],
		['an audio-only board, whose records use a third tag again', REAL_LEGACY_TAG_TX_DIRECTORY_HEX],
	])('reports no video tx channels for %s', (_label, hex) => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'AudioOnly' } } })
		const reply = Buffer.from(hex, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))

		expect(self.devicesData[REAL_DEVICE_IP]?.videoTx?.count).toBe(0)
	})

	it('schedules only the video tx variable types for a tx reply', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'Encoder-001' } } })
		const reply = Buffer.from(REAL_VIDEO_TX_DIRECTORY_HEX, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))

		const written = (self.setVariableValues as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(written).toHaveProperty('Encoder-001_tx_video')
		expect(written).toHaveProperty('Encoder-001_tx_names_video')
		expect(written).not.toHaveProperty('Encoder-001_rx_video')
	})

	it('reports no source once the same channels are cleared', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910' } } })
		const reply = Buffer.from(REAL_VIDEO_ALL_CLEARED_HEX, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))

		const videoRx = self.devicesData[REAL_DEVICE_IP]?.videoRx
		expect(videoRx?.count).toBe(1)
		expect(videoRx?.[1]).toEqual({
			number: 1,
			name: 'Decoder Video Channel',
			sourceChannel: undefined,
			sourceDevice: undefined,
		})
	})

	it('schedules only the video rx variable types, not a full refresh', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910' } } })
		const reply = Buffer.from(REAL_VIDEO_ALL_ROUTED_HEX, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))

		const written = (self.setVariableValues as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(written).toHaveProperty('DAV-110910_rx_video')
		expect(written).toHaveProperty('DAV-110910_rx_names_video')
		expect(written).not.toHaveProperty('DAV-110910_tx_video')
		expect(written).not.toHaveProperty('DAV-110910_tx_names_video')
	})

	it('does not throw on a truncated reply', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910' } } })
		const full = Buffer.from(REAL_VIDEO_ALL_ROUTED_HEX, 'hex')
		for (const cutAt of [0, 8, 16, 18, 20, 96, 200]) {
			const truncated = full.subarray(0, cutAt)
			expect(() => parseAvReply(self, truncated, makeRinfo(REAL_DEVICE_IP, truncated.length))).not.toThrow()
		}
	})

	it('does not throw when a record pointer is corrupted to point past the end of the packet', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910' } } })
		const corrupted = Buffer.from(REAL_VIDEO_ALL_ROUTED_HEX, 'hex')
		corrupted.writeUInt16BE(0xffff, 18) // first record pointer, now well past the packet
		expect(() => parseAvReply(self, corrupted, makeRinfo(REAL_DEVICE_IP, corrupted.length))).not.toThrow()
	})
})

describe('getVideoRxChannelSource / findVideoRxChannelByName / findVideoTxChannelByName', () => {
	it('reads the current video subscription source', () => {
		const self = createMockInstance({
			devicesData: {
				'10.0.0.5': { videoRx: { 1: { number: 1, sourceChannel: 'Tx 1', sourceDevice: 'Sender' } } },
			},
		})
		expect(getVideoRxChannelSource(self, '10.0.0.5', 1)).toEqual({ deviceName: 'Sender', channelName: 'Tx 1' })
	})

	it('returns undefined for an unrouted channel', () => {
		const self = createMockInstance({ devicesData: { '10.0.0.5': { videoRx: { 1: { number: 1 } } } } })
		expect(getVideoRxChannelSource(self, '10.0.0.5', 1)).toBeUndefined()
	})

	it('finds a video rx/tx channel by name', () => {
		const self = createMockInstance({
			devicesData: {
				'10.0.0.5': { name: 'Dest', videoRx: { 1: { number: 1, name: 'Decoder Video Channel' } } },
				'10.0.0.6': { name: 'Source', videoTx: { 1: { number: 1, name: 'Transmit Video Channel' } } },
			},
		})
		expect(findVideoRxChannelByName(self, 'Dest', 'Decoder Video Channel')?.number).toBe(1)
		expect(findVideoTxChannelByName(self, 'Source', 'Transmit Video Channel')?.number).toBe(1)
		expect(findVideoRxChannelByName(self, 'Dest', 'No such channel')).toBeUndefined()
	})
})

/**
 * A device's video channel counts arrive as two replies, one per direction, and every device
 * answers both - an audio-only board included, whose answers simply hold no video records. Logging
 * each reply as it landed put two lines in the log per device, one of them meaningless on its own
 * ("video rx channels - 0"), and three for every audio-only device on the network counting its
 * audio line.
 */
describe('video channel count logging', () => {
	/** The info lines the module emitted, whatever scope they came from. */
	function infoLines(): string[] {
		return loggerSink.mock.calls.filter((call) => call[1] === 'info').map((call) => String(call[2]))
	}

	function deliver(self: DanteInstance, hex: string) {
		const reply = Buffer.from(hex, 'hex')
		parseAvReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))
	}

	/** The same directory reply, re-tagged as the rx-side answer - see REAL_AUDIO_ONLY_TX_DIRECTORY_HEX. */
	function asRxDirectory(hex: string): string {
		const reply = Buffer.from(hex, 'hex')
		reply.writeUInt16BE(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY, 6)
		return reply.toString('hex')
	}

	function device() {
		return createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'DAV-110910', ports: { ARC: 4440 } } } })
	}

	it('says nothing until the direction that completes the pair arrives', () => {
		const self = device()
		deliver(self, REAL_VIDEO_ALL_ROUTED_HEX)

		expect(infoLines().filter((line) => line.includes('video'))).toEqual([])
	})

	it('reports both directions on one line', () => {
		const self = device()
		deliver(self, REAL_VIDEO_ALL_ROUTED_HEX)
		deliver(self, REAL_VIDEO_TX_DIRECTORY_HEX)

		const lines = infoLines().filter((line) => line.includes('video channels'))
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('DAV-110910')
		expect(lines[0]).toContain('rx 1')
		expect(lines[0]).toContain('tx 1')
	})

	it('does not repeat itself when a refresh finds the same counts', () => {
		const self = device()
		deliver(self, REAL_VIDEO_ALL_ROUTED_HEX)
		deliver(self, REAL_VIDEO_TX_DIRECTORY_HEX)
		// what the Refresh action does: ask both directions again
		deliver(self, REAL_VIDEO_ALL_ROUTED_HEX)
		deliver(self, REAL_VIDEO_TX_DIRECTORY_HEX)

		expect(infoLines().filter((line) => line.includes('video channels'))).toHaveLength(1)
	})

	it('keeps quiet about a device that has no video channels at all', () => {
		// every audio-only device on the network answers both queries this way, and none of it is news
		const self = device()
		deliver(self, asRxDirectory(REAL_AUDIO_ONLY_TX_DIRECTORY_HEX))
		deliver(self, REAL_AUDIO_ONLY_TX_DIRECTORY_HEX)

		expect(self.devicesData[REAL_DEVICE_IP]?.videoRx?.count).toBe(0)
		expect(self.devicesData[REAL_DEVICE_IP]?.videoTx?.count).toBe(0)
		expect(infoLines().filter((line) => line.includes('video'))).toEqual([])
	})

	it('reports a count that changes later, still on one line', () => {
		const self = device()
		deliver(self, asRxDirectory(REAL_AUDIO_ONLY_TX_DIRECTORY_HEX))
		deliver(self, REAL_AUDIO_ONLY_TX_DIRECTORY_HEX)
		loggerSink.mockClear()

		deliver(self, REAL_VIDEO_TX_DIRECTORY_HEX)

		const lines = infoLines().filter((line) => line.includes('video channels'))
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('rx 0')
		expect(lines[0]).toContain('tx 1')
	})
})
