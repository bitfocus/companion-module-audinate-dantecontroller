import { vi } from 'vitest'
import { handleCommandReply, notifyRxStateChanged } from '../api/index.js'
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
				notifyRxStateChanged(self, ip)
				handleCommandReply(self, ackFor(command, answer.result), { address: ip })
			})
		},
	)
}
