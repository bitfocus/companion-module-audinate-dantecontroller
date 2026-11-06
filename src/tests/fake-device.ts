import { vi } from 'vitest'
import { asDeviceIp, DANTE_CONST, handleCommandReply, notifyRxStateChanged } from '../api/index.js'
import type DanteInstance from '../main.js'

/**
 * A device's acknowledgement of `command`: its 10-byte header echoed, with `result` in the
 * result-code slot - the shape measured on Ultimo X2 hardware for subscribe and clear.
 */
export function ackFor(command: Buffer, result = 0x0001): Buffer {
	const reply = Buffer.from(command.subarray(0, 10))
	reply.writeUInt16BE(10, 2)
	reply.writeUInt16BE(result, 8)
	return reply
}

/** How a fake device answers one packet: with a result code, after optionally changing its state. */
export interface FakeAnswer {
	result?: number
	/** Applied before the acknowledgement arrives, as a device applies a subscription before answering. */
	apply?: () => void
}

/**
 * A socket `send` for a device that answers. `respond` sees every packet sent and returns how to
 * answer it, or undefined to stay silent. Answers arrive asynchronously, through the same entry
 * points a real reply takes.
 */
export function answeringSend(
	self: DanteInstance,
	respond: (command: Buffer, ip: string) => FakeAnswer | undefined,
): ReturnType<typeof vi.fn> {
	return vi.fn(
		(
			command: Buffer,
			_offset: number,
			_length: number,
			_port: number,
			ip: string,
			callback?: (error: Error | null) => void,
		) => {
			callback?.(null)
			const answer = respond(command, ip)
			if (!answer) return
			queueMicrotask(() => {
				answer.apply?.()
				notifyRxStateChanged(self, asDeviceIp(ip))
				handleCommandReply(self, ackFor(command, answer.result), { address: ip })
			})
		},
	)
}

/**
 * An rx channel-query reply, as the device sends it in answer to a query - including the one the
 * module makes on each rx change notification, which is how a subscription's status reaches it.
 */
export function rxReply(
	channels: { number: number; name: string; source?: string; channel?: string; status: number }[],
): Buffer {
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
