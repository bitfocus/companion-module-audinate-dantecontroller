/**
 * Waiting for a device to answer a command, and for its state to show the command took effect.
 */

import type dgram from 'node:dgram'
import type DanteInstance from '../main.js'
import { sendCommand } from './connection.js'

/**
 * A command the module could not carry out, with a message meant for whoever ran it.
 *
 * Action callbacks let this propagate, so Companion (and a router driving the module) see the
 * action fail with this message instead of a success that did nothing.
 */
export class DanteCommandError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'DanteCommandError'
	}
}

/**
 * Result codes a device puts in bytes 8-9 of its reply, where a request carries `0x0000`. Only these
 * two mean the command was accepted - see `isAccepted`. The rest are rejections; the ones listed
 * are the ones seen in the field and documented by the netaudio project.
 */
export const RESULT_CODE = {
	SUCCESS: 0x0001,
	/** Accepted, and more of a paged reply follows. */
	MORE_PAGES: 0x8112,
	ERROR: 0x0022,
	/** Seen for a subscribe to a receive channel number the device does not have. */
	NO_SUCH_CHANNEL: 0x8101,
} as const

const isAccepted = (code: number) => code === RESULT_CODE.SUCCESS || code === RESULT_CODE.MORE_PAGES

/** How a device answered one command. */
export type CommandAck =
	| { kind: 'accepted'; code: number }
	| { kind: 'rejected'; code: number }
	/** No reply after every attempt. The command may still have arrived; only state can tell. */
	| { kind: 'unanswered' }

interface PendingCommand {
	resolve: (reply: Buffer) => void
	reject: (error: Error) => void
}

const pendingByInstance = new WeakMap<DanteInstance, Map<string, PendingCommand>>()

function pendingFor(self: DanteInstance): Map<string, PendingCommand> {
	let pending = pendingByInstance.get(self)
	if (!pending) {
		pending = new Map()
		pendingByInstance.set(self, pending)
	}
	return pending
}

/** A command's transaction number, which the device echoes in bytes 4-5 of its reply. */
export const transactionId = (packet: Buffer): number => packet.readUInt16BE(4)

const pendingKey = (ip: string, packet: Buffer) => `${ip}#${transactionId(packet)}`

/**
 * Hands a reply to the command waiting for it, if any. Called for every packet on the ARC socket,
 * before the parsers: a reply to a query is parsed as usual and simply matches nothing here.
 * Returns whether it matched.
 */
export function handleCommandReply(
	self: DanteInstance,
	reply: Buffer,
	rinfo: Pick<dgram.RemoteInfo, 'address'>,
): boolean {
	// header plus the result code
	if (reply.length < 10) return false
	const pending = pendingByInstance.get(self)
	const key = pendingKey(rinfo.address, reply)
	const waiting = pending?.get(key)
	if (!waiting) return false

	pending?.delete(key)
	waiting.resolve(reply)
	return true
}

/** Fails the command waiting on a packet the socket could not send. */
export function handleSendFailure(self: DanteInstance, ip: string, packet: Buffer, error: Error): void {
	if (packet.length < 6) return
	const pending = pendingByInstance.get(self)
	const key = pendingKey(ip, packet)
	const waiting = pending?.get(key)
	if (!waiting) return

	pending?.delete(key)
	waiting.reject(new DanteCommandError(`Could not send to ${ip}: ${error.message}`))
}

/** Fails every command still waiting, for when the connection is being torn down or replaced. */
export function cancelPendingCommands(self: DanteInstance): void {
	const pending = pendingByInstance.get(self)
	if (!pending) return
	pendingByInstance.delete(self)
	for (const waiting of pending.values()) {
		waiting.reject(new DanteCommandError('Connection closed before the device answered'))
	}
}

export interface AckOptions {
	/** How long to wait for each attempt's reply. */
	attemptTimeoutMs?: number
	/** How many times to send, the first included. Resending is safe: a command sets state. */
	attempts?: number
}

/** Matches netaudio, which a wide range of real devices has been used against. */
const DEFAULT_ACK_OPTIONS: Required<AckOptions> = { attemptTimeoutMs: 1000, attempts: 3 }

/**
 * Waits for a device's answer to a command that has just been sent with `sendCommand`, resending
 * it while there is none. Resolves with how the device answered; rejects only when the packet could
 * not be sent at all.
 *
 * Must be called in the same tick as the first send, so a reply cannot arrive before it is waited
 * for.
 */
export async function awaitCommandAck(
	self: DanteInstance,
	ip: string,
	command: Buffer,
	options: AckOptions = {},
): Promise<CommandAck> {
	const { attemptTimeoutMs, attempts } = { ...DEFAULT_ACK_OPTIONS, ...options }
	const pending = pendingFor(self)
	const key = pendingKey(ip, command)

	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (attempt > 1 && !sendCommand(self, command, ip)) {
			throw new DanteCommandError(`Could not resend the command to ${ip}`)
		}

		const reply = await new Promise<Buffer | undefined>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (pending.get(key) === waiting) pending.delete(key)
				resolve(undefined)
			}, attemptTimeoutMs)
			const waiting: PendingCommand = {
				resolve: (packet) => {
					clearTimeout(timer)
					resolve(packet)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			}
			pending.set(key, waiting)
		})

		if (reply) {
			const code = reply.readUInt16BE(8)
			return isAccepted(code) ? { kind: 'accepted', code } : { kind: 'rejected', code }
		}
	}

	return { kind: 'unanswered' }
}

// Receive channel state

const rxListeners = new WeakMap<DanteInstance, Set<(ip: string) => void>>()

/** Called by the parsers whenever a device's receive channel state has been merged. */
export function notifyRxStateChanged(self: DanteInstance, ip: string): void {
	const listeners = rxListeners.get(self)
	if (!listeners) return
	for (const listener of [...listeners]) listener(ip)
}

export interface ConfirmOptions {
	/** How long the state has to show the change before the command counts as failed. */
	timeoutMs?: number
	/** How often to ask the device again while it does not. */
	requeryMs?: number
}

const DEFAULT_CONFIRM_OPTIONS: Required<ConfirmOptions> = { timeoutMs: 3000, requeryMs: 500 }

/**
 * Waits until `matches` holds for a device's receive channel state, asking the device for its
 * channels with `requery` meanwhile. Resolves true when it holds, false on timeout.
 *
 * This is what makes a crosspoint command's success real: a device can accept a command and still
 * not apply it, and the acknowledgement alone cannot tell. Devices also announce routing changes
 * on their own, so the state usually arrives without the re-query.
 */
export async function awaitRxState(
	self: DanteInstance,
	ip: string,
	matches: () => boolean,
	requery: () => void,
	options: ConfirmOptions = {},
): Promise<boolean> {
	if (matches()) return true

	const { timeoutMs, requeryMs } = { ...DEFAULT_CONFIRM_OPTIONS, ...options }
	let listeners = rxListeners.get(self)
	if (!listeners) {
		listeners = new Set()
		rxListeners.set(self, listeners)
	}
	const registered = listeners

	return await new Promise<boolean>((resolve) => {
		const finish = (result: boolean) => {
			clearTimeout(deadline)
			clearInterval(poll)
			registered.delete(listener)
			resolve(result)
		}
		const listener = (changedIp: string) => {
			if (changedIp === ip && matches()) finish(true)
		}
		const deadline = setTimeout(() => finish(matches()), timeoutMs)
		const poll = setInterval(requery, requeryMs)
		registered.add(listener)
		requery()
	})
}
