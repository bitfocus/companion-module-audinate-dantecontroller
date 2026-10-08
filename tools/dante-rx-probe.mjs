/**
 * Dumps the live receive-channel routing state of a Dante device.
 *
 *   node tools/dante-rx-probe.mjs                 # discover devices on the network
 *   node tools/dante-rx-probe.mjs <device-ip>     # dump that device's rx channels
 *
 * Prints, per receive channel, the reported source device and channel plus both status fields from
 * the channel record - including the subscription status at offset 14 that the crosspoint feedbacks
 * gate on. Use it to answer "what does a real device actually report for this route?" rather than
 * inferring it: set the route in Dante Controller, run this, read the code.
 *
 * Deliberately standalone. It duplicates a handful of protocol constants from `src/const.ts` and
 * the packet framing from `makeCommand` (verified byte-identical) rather than importing from
 * `dist/`, so it still works when the build is broken - which is exactly when you want to inspect
 * what is on the wire.
 */

import dgram from 'node:dgram'
import mdns from 'multicast-dns'

const PROTOCOL_CONTROL = 0x2729
const ARC_PORT = 4440

const OPCODE_CHANNEL_COUNT = 0x1000
const OPCODE_RX_CHANNEL_QUERY = 0x3000

const RX_CHANNELS_PER_PAGE = 16
const RX_RECORD_SIZE = 20
const BODY_START = 12

// rx channel record layout, offsets within a record
const REC_CHANNEL_NUMBER = 0
const REC_SOURCE_CHANNEL_POINTER = 6
const REC_SOURCE_DEVICE_POINTER = 8
const REC_NAME_POINTER = 10
const REC_CHANNEL_STATUS = 12
const REC_SUBSCRIPTION_STATUS = 14

/** Subscription statuses the module treats as connected - keep in step with `src/const.ts`. */
const CONNECTED = new Map([
	[0x0004, 'self'],
	[0x0009, 'unicast'],
	[0x000a, 'multicast'],
	[0x000e, 'unverified'],
])

const REPLY_WAIT_MS = 1500
const DISCOVERY_WAIT_MS = 4000

function u16(value) {
	const buffer = Buffer.alloc(2)
	buffer.writeUInt16BE(value, 0)
	return buffer
}

let counter = 0

/** Builds an ARC query, matching the framing `makeCommand` in `src/api.ts` produces. */
function makeQuery(opcode, startChannel = 1) {
	const args = Buffer.from('0001000100', 'hex')
	args.writeUInt8(startChannel, 3)
	return Buffer.concat([
		u16(PROTOCOL_CONTROL),
		u16(args.length + 11),
		u16(++counter),
		u16(opcode),
		u16(0), // request flag
		args,
		Buffer.from([0x00]),
	])
}

/** Reads the NUL-terminated string a record pointer refers to, tolerating a pointer off the end. */
function stringAt(buffer, pointer) {
	if (!pointer || pointer >= buffer.length) return ''
	const end = buffer.indexOf(0x00, pointer)
	return buffer.toString('utf8', pointer, end === -1 ? buffer.length : end)
}

function hex16(value) {
	return `0x${value.toString(16).padStart(4, '0')}`
}

async function discover() {
	const browser = mdns()
	const found = new Map()

	browser.on('warning', () => {})
	browser.on('error', (error) => console.error(`mDNS: ${error.message}`))
	browser.on('response', (response, rinfo) => {
		for (const answer of [...response.answers, ...response.additionals]) {
			if (answer.type === 'SRV' && answer.name.includes('_netaudio-arc')) {
				found.set(rinfo.address, answer.name.slice(0, answer.name.indexOf('.')))
			}
		}
	})
	browser.query({
		questions: [
			{ name: '_netaudio-arc._udp.local', type: 'PTR' },
			{ name: '_netaudio-cmc._udp.local', type: 'PTR' },
		],
	})

	await new Promise((resolve) => setTimeout(resolve, DISCOVERY_WAIT_MS))
	browser.destroy()
	return found
}

/** Sends `queries` to a device and collects every ARC reply that arrives within the wait window. */
async function ask(host, queries) {
	const socket = dgram.createSocket('udp4')
	const replies = []

	socket.on('message', (reply) => {
		if (reply.length >= 8 && reply.readUInt16BE(0) === PROTOCOL_CONTROL) replies.push(reply)
	})

	await new Promise((resolve) => socket.bind(0, resolve))
	for (const query of queries) socket.send(query, 0, query.length, ARC_PORT, host)
	await new Promise((resolve) => setTimeout(resolve, REPLY_WAIT_MS))
	socket.close()

	return replies
}

function parseRxPages(replies) {
	const channels = []

	for (const reply of replies) {
		if (reply.readUInt16BE(6) !== OPCODE_RX_CHANNEL_QUERY) continue
		const recordCount = reply[11]

		for (let index = 0; index < Math.min(recordCount, RX_CHANNELS_PER_PAGE); index++) {
			const at = BODY_START + RX_RECORD_SIZE * index
			const record = reply.subarray(at, at + RX_RECORD_SIZE)
			if (record.length < RX_RECORD_SIZE) break

			const number = record.readUInt16BE(REC_CHANNEL_NUMBER)
			if (number === 0) break

			channels.push({
				number,
				name: stringAt(reply, record.readUInt16BE(REC_NAME_POINTER)),
				sourceDevice: stringAt(reply, record.readUInt16BE(REC_SOURCE_DEVICE_POINTER)),
				sourceChannel: stringAt(reply, record.readUInt16BE(REC_SOURCE_CHANNEL_POINTER)),
				channelStatus: record.readUInt16BE(REC_CHANNEL_STATUS),
				subscriptionStatus: record.readUInt16BE(REC_SUBSCRIPTION_STATUS),
			})
		}
	}

	return channels.sort((a, b) => a.number - b.number)
}

function report(channels) {
	console.log('')
	console.log('  ch  rx name          source device        source channel   status@12  subscription@14')
	console.log('  ' + '-'.repeat(90))

	for (const channel of channels) {
		const status = channel.subscriptionStatus
		const label =
			status === 0 ? '' : ` ${CONNECTED.has(status) ? `connected/${CONNECTED.get(status)}` : 'NOT CONNECTED'}`
		console.log(
			`  ${String(channel.number).padStart(2)}  ${channel.name.padEnd(15).slice(0, 15)} ` +
				`${channel.sourceDevice.padEnd(20).slice(0, 20)} ${channel.sourceChannel.padEnd(16).slice(0, 16)} ` +
				`${hex16(channel.channelStatus)}     ${hex16(status)} (${status})${label}`,
		)
	}

	const routed = channels.filter((channel) => channel.sourceDevice)
	const unknown = [...new Set(routed.map((c) => c.subscriptionStatus).filter((s) => !CONNECTED.has(s) && s !== 0))]

	console.log('')
	console.log(`  ${routed.length} of ${channels.length} channels routed`)
	if (unknown.length > 0) {
		console.log(`  UNRECOGNISED status on a routed channel: ${unknown.map(hex16).join(', ')}`)
		console.log('  If the route is healthy in Dante Controller, add the code to SUBSCRIPTION_STATUS in src/const.ts.')
	}
	console.log('')
}

async function main() {
	const host = process.argv[2]

	if (!host) {
		const found = await discover()
		if (found.size === 0) {
			console.error('No Dante devices answered. Check you are on the right network interface.')
			process.exitCode = 2
			return
		}
		console.log('\nDante devices:')
		for (const [ip, name] of found) console.log(`  ${ip.padEnd(16)} ${name}`)
		console.log(`\nRe-run with an address, e.g.: node tools/dante-rx-probe.mjs ${[...found.keys()][0]}\n`)
		return
	}

	// Ask the device how many receive channels it has, so the right number of pages get queried.
	const [countReply] = await ask(host, [makeQuery(OPCODE_CHANNEL_COUNT)])
	if (!countReply) {
		console.error(`No reply from ${host}:${ARC_PORT} - wrong address, or blocked by a firewall/interface.`)
		process.exitCode = 2
		return
	}
	const rxCount = countReply[15]

	const pages = Math.max(1, Math.ceil(rxCount / RX_CHANNELS_PER_PAGE))
	const queries = []
	for (let page = 0; page < pages; page++) {
		queries.push(makeQuery(OPCODE_RX_CHANNEL_QUERY, page * RX_CHANNELS_PER_PAGE + 1))
	}

	const channels = parseRxPages(await ask(host, queries))
	if (channels.length === 0) {
		console.error(`${host} reports ${rxCount} rx channels but returned no channel records.`)
		process.exitCode = 2
		return
	}

	console.log(`\n${host} - ${rxCount} rx channels, ${pages} page(s)`)
	report(channels)
}

await main()
