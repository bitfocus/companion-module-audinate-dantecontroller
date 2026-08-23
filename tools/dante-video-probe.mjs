/**
 * Sets/clears a video crosspoint on a Dante AV-X device (e.g. Audinate/TurtleAV DAV-xxxx boards)
 * and dumps the rx-channel status reply before/after, so the effect can be read straight off the
 * wire rather than inferred.
 *
 *   node tools/dante-video-probe.mjs <rx-ip> <rx-channel-name> <tx-device-name> <tx-channel-name>
 *   node tools/dante-video-probe.mjs 169.254.2.58 01 DAV-110b52 01
 *   node tools/dante-video-probe.mjs 169.254.2.58 01 --clear
 *
 * REVERSE-ENGINEERING STATUS (2026-08-23) - see the `dante-video-routing-protocol` memory for the
 * full writeup. Summary:
 *
 * - These "dante-av-x" boards (mDNS `router_info=dante-av-x`) speak a second protocol tagged
 *   `0x2809` over the *same* ARC socket (UDP/4440) as plain audio Dante, alongside the normal
 *   `0x2729` CONTROL traffic this module already implements. `0x2809` was previously in
 *   `src/api/const.ts` as `AES67_CONFIG` - that name is wrong/incomplete, it's this vendor's
 *   general extended-control envelope and video crosspoints live there too.
 * - Opcode `0x3410`, sent to the **destination** (rx) device, is the crosspoint write. Confirmed
 *   byte-identical against a real Dante Controller capture, and confirmed live (this script) to
 *   actually drive the hardware, repeatably, in both directions.
 *     - Clear: the fixed 14-byte object-address prefix (`00000000000008000301000100040000`
 *       truncated - see OBJECT_PREFIX below) with no further args.
 *     - Set: object-address prefix + two u16 pointers (always 44 and 44+len(channelName)+1,
 *       because there's a fixed 16-byte gap after the pointers before the string data starts) +
 *       16 zero bytes + the source channel name (NUL-terminated) + source device name
 *       (NUL-terminated).
 *   The last 2 bytes of the 8-byte tag inside the object-address prefix (`0004` here) might be a
 *   channel index rather than a fixed constant - only verified against channel 1, since these
 *   test devices have exactly one video channel each.
 * - Query opcode is channel-specific (`0x3600` was this rx channel's; a different rx channel would
 *   presumably get a different opcode the same way legacy audio pages by channel). The reply grows
 *   from 128 to 240 bytes when the channel is routed, and the u16 at byte offset 16 flips
 *   0x0301 -> 0x0302 - reliable for a connected/not-connected boolean (verified across 3 live
 *   toggle cycles).
 * - NOT yet solved: the rx-side reply never contains the source device/channel as text, only an
 *   opaque per-flow tag plus the rx device's own address. So there's currently no wire-verified way
 *   to read back *what* a video channel is subscribed to (only *whether*) straight from the rx
 *   device. The tx side's reply *does* echo the subscriber's name in plaintext - `Channel
 *   Subscription`-style feedback might have to be resolved by cross-referencing every known tx
 *   device's channel table rather than reading the rx device alone. Picking this up next session.
 */

import dgram from 'node:dgram'

const ARC_PORT = 4440
const EXT_PROTOCOL = 0x2809

// Captured verbatim from a real Dante Controller session driving DAV-110910 channel 1. Slicing off
// the first 10 bytes (proto, len, counter, opcode, flags) of each gives reusable arg templates.
const CAPTURED_QUERY_CH1 = Buffer.from(
	'28090022005336000000000000000000000100010001000000000000000000000000',
	'hex',
)
const CAPTURED_CLEAR_CH1 = Buffer.from(
	'2809002c00513410000000000000000008000301000100040000000000000000000000000000000000000000',
	'hex',
)

const QUERY_ARGS = CAPTURED_QUERY_CH1.subarray(10)
const CLEAR_ARGS = CAPTURED_CLEAR_CH1.subarray(10)
/** Fixed 14-byte object-address prefix: 6 zero bytes + `0800 0301 0001 0004`. */
const OBJECT_PREFIX = CLEAR_ARGS.subarray(0, 14)
/** Fixed gap between the two name pointers and where the pointed-to strings actually start. */
const NAME_PAD = Buffer.alloc(16)

let counter = Math.floor(Math.random() * 0xff00) + 0x100

function u16(value) {
	const buffer = Buffer.alloc(2)
	buffer.writeUInt16BE(value, 0)
	return buffer
}

function makeExt(opcode, args) {
	return Buffer.concat([u16(EXT_PROTOCOL), u16(10 + args.length), u16(counter++), u16(opcode), u16(0), args])
}

function makeVideoQuery() {
	return makeExt(0x3600, QUERY_ARGS)
}

function makeVideoClear() {
	return makeExt(0x3410, CLEAR_ARGS)
}

function makeVideoSubscribe(sourceChannelName, sourceDeviceName) {
	const channelNameBuffer = Buffer.from(sourceChannelName, 'ascii')
	const deviceNameBuffer = Buffer.from(sourceDeviceName, 'ascii')
	const pointer1 = 10 + OBJECT_PREFIX.length + 4 + NAME_PAD.length
	const pointer2 = pointer1 + channelNameBuffer.length + 1
	const args = Buffer.concat([
		OBJECT_PREFIX,
		u16(pointer1),
		u16(pointer2),
		NAME_PAD,
		channelNameBuffer,
		Buffer.from([0]),
		deviceNameBuffer,
		Buffer.from([0]),
	])
	return makeExt(0x3410, args)
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

function report(label, replies) {
	console.log(`\n--- ${label} ---`)
	if (replies.length === 0) {
		console.log('  (no reply)')
		return
	}
	for (const reply of replies) {
		const connected = reply.length >= 18 && reply[17] === 0x02
		const flag = reply.length >= 18 ? `, flag@16=0x${reply.readUInt16BE(16).toString(16).padStart(4, '0')}` : ''
		console.log(`  ${reply.toString('hex')}  (${reply.length} bytes${flag}${connected ? ' - CONNECTED' : ''})`)
	}
}

async function main() {
	const [rxIp, rxChannelName, arg3, arg4] = process.argv.slice(2)
	if (!rxIp || !rxChannelName) {
		console.error('Usage: node tools/dante-video-probe.mjs <rx-ip> <rx-channel-name> <tx-device-name> <tx-channel-name>')
		console.error('       node tools/dante-video-probe.mjs <rx-ip> <rx-channel-name> --clear')
		process.exitCode = 2
		return
	}

	report('BEFORE', await send(rxIp, makeVideoQuery()))

	if (arg3 === '--clear') {
		console.log('\n>>> clearing...')
		await send(rxIp, makeVideoClear())
	} else {
		if (!arg3 || !arg4) {
			console.error('Need both <tx-device-name> and <tx-channel-name> to subscribe, or pass --clear.')
			process.exitCode = 2
			return
		}
		console.log(`\n>>> subscribing to ${arg3} / ${arg4}...`)
		await send(rxIp, makeVideoSubscribe(arg4, arg3))
	}

	await new Promise((resolve) => setTimeout(resolve, 1000))
	report('AFTER', await send(rxIp, makeVideoQuery()))
}

await main()
