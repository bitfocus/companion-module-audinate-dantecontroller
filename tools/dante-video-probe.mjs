/**
 * Reads and writes video routing on a Dante AV-X device (Audinate/TurtleAV DAV-xxxx, TAV-xxxx)
 * straight off the wire, independently of the module - for checking what hardware actually reports
 * when the module's own view looks wrong.
 *
 *   node tools/dante-video-probe.mjs <ip>                                  # list rx + tx channels
 *   node tools/dante-video-probe.mjs <ip> --raw                            # ...and dump reply hex
 *   node tools/dante-video-probe.mjs <ip> --clear <rxChannel>
 *   node tools/dante-video-probe.mjs <ip> --set <rxChannel> <txDevice> <txChannel>
 *   node tools/dante-video-probe.mjs --decode <replyHex>                   # no network needed
 *   node tools/dante-video-probe.mjs --self-test                           # no network needed
 *
 *   node tools/dante-video-probe.mjs 169.254.2.58
 *   node tools/dante-video-probe.mjs 169.254.2.58 --set 1 Encoder-001 "Transmit Video Channel"
 *
 * PROTOCOL SUMMARY - see the `dante-video-routing-protocol` project notes for the full derivation.
 *
 * These boards (mDNS `router_info=dante-av-x`) carry video routing over a second protocol tagged
 * `0x28xx` on the *same* ARC socket (UDP/4440) as the `0x2729` CONTROL protocol used for audio. The
 * low byte varies per controlling-app session and any fixed value works; this script and the module
 * both send `0x2809`.
 *
 * Opcodes used here, all confirmed against live hardware:
 *   0x3400  rx channel directory - every rx channel's name and live source, audio and video together
 *   0x2400  tx channel directory - the same for transmit channels
 *   0x3410  set/clear a crosspoint, sent to the *destination* (rx) device
 *
 * Three traps, each of which cost a debugging session and all of which this script demonstrates the
 * right side of:
 *
 *  1. Both directory queries need the fixed 24-byte `DIRECTORY_ARGS` below. Sent with no arguments
 *     they are still acknowledged - correct opcode echoed, reply flag set - but always report zero
 *     records, which is indistinguishable from a device having no channels.
 *  2. `0x2600` looks like the tx-side directory and is not: it returns the device's active outbound
 *     *flows* (one record per subscriber, names reading "1"/"2", the subscriber's device name where
 *     a source name would be). `0x2400` is the real one.
 *  3. A record's kind must be read from its media type field at +6 (`0x0003` audio / `0x0004`
 *     video). The opaque tag at +0 varies by reply kind *and* device model - `0x161e`/`0x161c` in an
 *     rx directory, `0x1616` for both media types in an AV-X tx directory, `0x1414` in an audio-only
 *     board's - so matching on it works only against whichever device it was derived from.
 *
 * Also note record offset +8 is the channel's number within its own media type (what a crosspoint
 * command addresses it by), while +2 is its position across all the device's channels combined - a
 * sole video channel listed after two audio ones reports +2 = 3 but +8 = 1.
 */

import dgram from 'node:dgram'

const ARC_PORT = 4440
const EXT_PROTOCOL = 0x2809

const MEDIA_TYPE = { 3: 'audio', 4: 'video' }
const AUDIO = 0x0003
const VIDEO = 0x0004

const OPCODE = { RX_DIRECTORY: 0x3400, TX_DIRECTORY: 0x2400, CROSSPOINT: 0x3410 }

/** Required argument bytes for both directory queries - see trap 1 above. */
const DIRECTORY_ARGS = Buffer.from('000000000000000100010001000000000000000000000000', 'hex')

/** Fixed gap between a crosspoint command's two name pointers and the strings they point at. */
const NAME_PAD = Buffer.alloc(16)

/** Real captures, used by --self-test to prove the builders below still produce genuine packets. */
const CAPTURED_CLEAR_CH1 = '2809002c00513410000000000000000008000301000100040000000000000000000000000000000000000000'
const CAPTURED_SUBSCRIBE_CH1 =
	'2809003a0058341000000000000000000800030100010004002c002f0000000000000000000000000000000030' +
	'31004441562d31313062353200'

let counter = Math.floor(Math.random() * 0xff00) + 0x100

function u16(value) {
	const buffer = Buffer.alloc(2)
	buffer.writeUInt16BE(value, 0)
	return buffer
}

function makeExt(opcode, args) {
	return Buffer.concat([u16(EXT_PROTOCOL), u16(10 + args.length), u16(counter++), u16(opcode), u16(0), args])
}

/**
 * The 14-byte object-address prefix a crosspoint command opens with: 6 zero bytes, the crosspoint
 * tag, the entry count as a `[0x03][count]` byte pair, then the entry's destination channel and
 * media type. Only single-entry commands are built here; the opcode does support batching.
 */
function crosspointPrefix(destinationChannel, mediaType) {
	return Buffer.concat([
		Buffer.alloc(6),
		u16(0x0800),
		Buffer.from([0x03, 0x01]),
		u16(destinationChannel),
		u16(mediaType),
	])
}

function makeCrosspointClear(destinationChannel, mediaType = VIDEO) {
	// Two null pointers where a set would name a source, then the same 16-byte pad.
	return makeExt(OPCODE.CROSSPOINT, Buffer.concat([crosspointPrefix(destinationChannel, mediaType), Buffer.alloc(20)]))
}

function makeCrosspointSet(destinationChannel, sourceDeviceName, sourceChannelName, mediaType = VIDEO) {
	const prefix = crosspointPrefix(destinationChannel, mediaType)
	const channelName = Buffer.from(sourceChannelName, 'ascii')
	const deviceName = Buffer.from(sourceDeviceName, 'ascii')
	// Pointers are absolute offsets from the start of the packet, hence the 10-byte header.
	const channelPointer = 10 + prefix.length + 4 + NAME_PAD.length
	const devicePointer = channelPointer + channelName.length + 1
	return makeExt(
		OPCODE.CROSSPOINT,
		Buffer.concat([
			prefix,
			u16(channelPointer),
			u16(devicePointer),
			NAME_PAD,
			channelName,
			Buffer.from([0]),
			deviceName,
			Buffer.from([0]),
		]),
	)
}

function readU16(buffer, at) {
	return at >= 0 && at + 2 <= buffer.length ? buffer.readUInt16BE(at) : undefined
}

/** Reads a NUL-terminated string at a pointer the packet supplies; 0 means "absent". */
function stringAt(buffer, pointer) {
	if (!pointer || pointer >= buffer.length) return undefined
	const end = buffer.indexOf(0, pointer)
	return buffer.subarray(pointer, end === -1 ? buffer.length : end).toString('ascii')
}

/**
 * Decodes a channel-directory reply into one entry per record.
 *
 * The record count at offset 16 is a `[0x03][count]` byte pair, not a u16 - read as one, a
 * 3-channel reply claims 771 records.
 */
function parseDirectory(reply) {
	const records = []
	const count = reply.length > 17 ? reply[17] : 0
	for (let i = 0; i < count; i++) {
		const start = readU16(reply, 18 + i * 2)
		if (start === undefined || start >= reply.length) continue
		records.push({
			tag: readU16(reply, start),
			combinedPosition: readU16(reply, start + 2),
			mediaType: readU16(reply, start + 6),
			channelNumber: readU16(reply, start + 8),
			name: stringAt(reply, readU16(reply, start + 20)),
			sourceChannel: stringAt(reply, readU16(reply, start + 48)),
			sourceDevice: stringAt(reply, readU16(reply, start + 50)),
		})
	}
	return records
}

async function send(host, buffer, waitMs = 800) {
	const socket = dgram.createSocket('udp4')
	const replies = []
	socket.on('message', (reply) => replies.push(reply))
	await new Promise((resolve) => socket.bind(0, resolve))
	socket.send(buffer, 0, buffer.length, ARC_PORT, host)
	await new Promise((resolve) => setTimeout(resolve, waitMs))
	socket.close()
	return replies
}

function printReply(reply, showRaw) {
	if (showRaw) console.log(`  raw (${reply.length}b): ${reply.toString('hex')}`)
	const records = parseDirectory(reply)
	if (records.length === 0) {
		console.log('  (no channel records)')
		return
	}
	// Only a receive channel has a source. The +48/+50 pointers mean something else entirely in a tx
	// directory - one real device dereferences them to junk like `r.$` - so don't render them there
	// and invite someone to read meaning into it. The module ignores them for tx for the same reason.
	const isReceiveSide = readU16(reply, 6) === OPCODE.RX_DIRECTORY
	for (const record of records) {
		const kind = MEDIA_TYPE[record.mediaType] ?? `unknown(0x${record.mediaType?.toString(16)})`
		const route = !isReceiveSide
			? ''
			: record.sourceDevice
				? `  <- ${record.sourceDevice} / ${record.sourceChannel}`
				: '  (no source)'
		console.log(
			`  ${kind.padEnd(5)} ch ${record.channelNumber}  ${JSON.stringify(record.name ?? '')}${route}` +
				`   [tag 0x${record.tag?.toString(16)}, combined pos ${record.combinedPosition}]`,
		)
	}
}

async function showDirectory(ip, label, opcode, showRaw) {
	const replies = await send(ip, makeExt(opcode, DIRECTORY_ARGS))
	console.log(`\n--- ${label} (opcode 0x${opcode.toString(16)}) ---`)
	if (replies.length === 0) {
		console.log('  (no reply - device unreachable, or does not speak AV_EXTENDED)')
		return
	}
	for (const reply of replies) printReply(reply, showRaw)
}

/** Checks the command builders against real captures. Runs without a network. */
function selfTest() {
	// The counter and protocol bytes legitimately differ from any capture, so blank them first.
	const normalize = (buffer) => {
		const copy = Buffer.from(buffer)
		copy.writeUInt16BE(0, 0)
		copy.writeUInt16BE(0, 4)
		return copy.toString('hex')
	}
	const cases = [
		['clear video ch1', makeCrosspointClear(1, VIDEO), CAPTURED_CLEAR_CH1],
		['set video ch1 <- DAV-110b52/01', makeCrosspointSet(1, 'DAV-110b52', '01', VIDEO), CAPTURED_SUBSCRIBE_CH1],
	]
	let failures = 0
	for (const [label, built, capturedHex] of cases) {
		const ok = normalize(built) === normalize(Buffer.from(capturedHex, 'hex'))
		console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
		if (!ok) {
			failures++
			console.log(`      built:    ${normalize(built)}`)
			console.log(`      captured: ${normalize(Buffer.from(capturedHex, 'hex'))}`)
		}
	}
	// Audio uses the same opcode with a different media type - not exercised by the module (audio
	// keeps its legacy path) but confirmed present in a real 3-entry batch capture.
	console.log(`\naudio-typed clear for comparison: ${makeCrosspointClear(1, AUDIO).toString('hex')}`)
	return failures
}

function usage() {
	console.error('Usage: node tools/dante-video-probe.mjs <ip> [--raw]')
	console.error('       node tools/dante-video-probe.mjs <ip> --clear <rxChannel>')
	console.error('       node tools/dante-video-probe.mjs <ip> --set <rxChannel> <txDevice> <txChannel>')
	console.error('       node tools/dante-video-probe.mjs --decode <replyHex>')
	console.error('       node tools/dante-video-probe.mjs --self-test')
}

async function main() {
	const argv = process.argv.slice(2)
	if (argv[0] === '--self-test') {
		process.exitCode = selfTest() === 0 ? 0 : 1
		return
	}

	// Decode a directory reply captured elsewhere (a packet dump, a debug log) without a network.
	if (argv[0] === '--decode') {
		const hex = (argv[1] ?? '').replace(/[^0-9a-fA-F]/g, '')
		if (!hex) {
			usage()
			process.exitCode = 2
			return
		}
		const reply = Buffer.from(hex, 'hex')
		console.log(`--- decoded (${reply.length}b, opcode 0x${readU16(reply, 6)?.toString(16)}) ---`)
		printReply(reply, false)
		return
	}

	const [ip, mode] = argv
	if (!ip || ip.startsWith('--')) {
		usage()
		process.exitCode = 2
		return
	}

	const showRaw = argv.includes('--raw')

	if (mode === '--set' || mode === '--clear') {
		const channel = Number(argv[2])
		if (!Number.isInteger(channel) || channel < 1) {
			console.error('<rxChannel> must be the video channel number, counting from 1.')
			process.exitCode = 2
			return
		}
		await showDirectory(ip, 'BEFORE - rx channels', OPCODE.RX_DIRECTORY, showRaw)

		if (mode === '--clear') {
			console.log(`\n>>> clearing video channel ${channel}...`)
			await send(ip, makeCrosspointClear(channel, VIDEO))
		} else {
			const [, , , txDevice, txChannel] = argv
			if (!txDevice || !txChannel) {
				console.error('--set needs <rxChannel> <txDevice> <txChannel>.')
				process.exitCode = 2
				return
			}
			console.log(`\n>>> routing video channel ${channel} <- ${txDevice} / ${txChannel}...`)
			await send(ip, makeCrosspointSet(channel, txDevice, txChannel, VIDEO))
		}

		await new Promise((resolve) => setTimeout(resolve, 1000))
		await showDirectory(ip, 'AFTER - rx channels', OPCODE.RX_DIRECTORY, showRaw)
		return
	}

	await showDirectory(ip, 'rx channels', OPCODE.RX_DIRECTORY, showRaw)
	await showDirectory(ip, 'tx channels', OPCODE.TX_DIRECTORY, showRaw)
}

await main()
