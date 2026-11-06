/**
 * Waiting for a device to answer a command, and for its state to show the command took effect.
 */

import type dgram from 'node:dgram'
import type DanteInstance from '../main.js'
import { sendCommand } from './connection.js'
import { type DeviceIp, deviceIpOf } from './ids.js'
import type { ChannelMediaType } from './types.js'

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
	/**
	 * No reply after every attempt. The command may still have arrived; only state can tell.
	 * `sendError` is the last error the socket reported, if any attempt could not be sent.
	 */
	| { kind: 'unanswered'; sendError?: Error }

interface PendingCommand {
	resolve: (reply: Buffer) => void
	reject: (error: Error) => void
	sendFailed: (error: Error) => void
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

const pendingKey = (ip: DeviceIp, packet: Buffer) => `${ip}#${transactionId(packet)}`

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
	const key = pendingKey(deviceIpOf(rinfo), reply)
	const waiting = pending?.get(key)
	if (!waiting) return false

	pending?.delete(key)
	waiting.resolve(reply)
	return true
}

/**
 * Tells the command waiting on a packet that the socket could not send it. The wait goes on: to the
 * command this is a lost reply, because these errors are routine (see `sendCommand`) and the next
 * attempt can get through, or an earlier one may have arrived already.
 */
export function handleSendFailure(self: DanteInstance, ip: DeviceIp, packet: Buffer, error: Error): void {
	if (packet.length < 6) return
	pendingByInstance.get(self)?.get(pendingKey(ip, packet))?.sendFailed(error)
}

/** Fails everything still waiting on a device, for when the connection is being torn down or replaced. */
export function cancelPendingCommands(self: DanteInstance): void {
	const closed = () => new DanteCommandError('Connection closed before the device answered')

	const pending = pendingByInstance.get(self)
	pendingByInstance.delete(self)
	for (const waiting of pending?.values() ?? []) waiting.reject(closed())

	for (const waiter of [...(rxWaiters.get(self) ?? [])]) waiter.cancel(closed())
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
 * it while there is none. Resolves with how the device answered; rejects only when there is no
 * socket left to resend on, or the connection closes.
 *
 * Must be called in the same tick as the first send, so a reply cannot arrive before it is waited
 * for.
 */
export async function awaitCommandAck(
	self: DanteInstance,
	ip: DeviceIp,
	command: Buffer,
	options: AckOptions = {},
): Promise<CommandAck> {
	const { attemptTimeoutMs, attempts } = { ...DEFAULT_ACK_OPTIONS, ...options }
	const pending = pendingFor(self)
	const key = pendingKey(ip, command)
	let sendError: Error | undefined

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
				sendFailed: (error) => {
					sendError = error
				},
			}
			pending.set(key, waiting)
		})

		if (reply) {
			const code = reply.readUInt16BE(8)
			return isAccepted(code) ? { kind: 'accepted', code } : { kind: 'rejected', code }
		}
	}

	return sendError ? { kind: 'unanswered', sendError } : { kind: 'unanswered' }
}

// Receive channel state

/** Which receive channels a device's reply carried state for. */
export interface RxReport {
	mediaType: ChannelMediaType
	/** Left out when the reply is the whole directory, as a video one is. */
	channels?: readonly number[]
}

interface RxWaiter {
	onReport: (ip: DeviceIp, report: RxReport | undefined) => void
	cancel: (error: Error) => void
}

const rxWaiters = new WeakMap<DanteInstance, Set<RxWaiter>>()

/**
 * Called by the parsers whenever a device's receive channel state has been merged. Without `report`
 * the state is taken to cover every channel.
 */
export function notifyRxStateChanged(self: DanteInstance, ip: DeviceIp, report?: RxReport): void {
	for (const waiter of [...(rxWaiters.get(self) ?? [])]) waiter.onReport(ip, report)
}

/** A query a wait keeps sending. Waits on one device with the same `key` share it. */
export interface RxQuery {
	key: string
	send: () => void
}

interface RxPoll {
	queries: Map<string, RxQuery & { waits: number }>
	timer: ReturnType<typeof setInterval>
}

const rxPolls = new WeakMap<DanteInstance, Map<DeviceIp, RxPoll>>()

/**
 * Adds a query to its device's poll, returning how to take it out again.
 *
 * One poll per device, because some devices drop what they cannot keep up with: a Neutrik
 * NA2-D-LINE answers about the first five of a burst and discards the rest. A salvo of routes to
 * one receiver asking for its channels separately is such a burst, and takes the subscribes and
 * the replies that would confirm them down with it. So a query already in the poll is not sent
 * again, and each tick sends each query once however many waits want it.
 */
function joinRxPoll(self: DanteInstance, ip: DeviceIp, query: RxQuery, requeryMs: number): () => void {
	let polls = rxPolls.get(self)
	if (!polls) {
		polls = new Map()
		rxPolls.set(self, polls)
	}
	const devicePolls = polls

	let poll = devicePolls.get(ip)
	if (!poll) {
		const queries: RxPoll['queries'] = new Map()
		poll = {
			queries,
			timer: setInterval(() => {
				for (const { send } of queries.values()) send()
			}, requeryMs),
		}
		devicePolls.set(ip, poll)
	}
	const { queries, timer } = poll

	const joined = queries.get(query.key)
	if (joined) {
		joined.waits += 1
	} else {
		queries.set(query.key, { ...query, waits: 1 })
		query.send()
	}

	return () => {
		const entry = queries.get(query.key)
		if (!entry) return
		entry.waits -= 1
		if (entry.waits > 0) return
		queries.delete(query.key)
		if (queries.size > 0) return
		clearInterval(timer)
		devicePolls.delete(ip)
	}
}

export interface ConfirmOptions {
	/** How long the state has to show the change before the command counts as failed. */
	timeoutMs?: number
	/** How often to ask the device again while it does not. */
	requeryMs?: number
}

const DEFAULT_CONFIRM_OPTIONS: Required<ConfirmOptions> = { timeoutMs: 3000, requeryMs: 500 }

/** What {@link awaitRxState} waits for on one receive channel. */
export interface RxWait {
	ip: DeviceIp
	mediaType: ChannelMediaType
	channel: number
	/**
	 * Whether the channel's state is the one wanted. `reported` says a reply carrying this channel
	 * has arrived since the wait began, so the state is the device's word now rather than what it
	 * last said.
	 */
	matches: (reported: boolean) => boolean
	/** How to ask the device for this channel's state. */
	query: RxQuery
}

const reportCovers = (report: RxReport | undefined, wait: RxWait) =>
	report === undefined || (report.mediaType === wait.mediaType && (report.channels?.includes(wait.channel) ?? true))

/**
 * Waits until `matches` holds for a receive channel, asking the device for its state meanwhile.
 * Resolves true when it holds, false on timeout; rejects if the connection closes first.
 *
 * This is what makes a crosspoint command's success real: a device can accept a command and still
 * not apply it, and the acknowledgement alone cannot tell. Devices also announce routing changes
 * on their own, so the state usually arrives without the re-query.
 */
export async function awaitRxState(self: DanteInstance, wait: RxWait, options: ConfirmOptions = {}): Promise<boolean> {
	if (wait.matches(false)) return true

	const { timeoutMs, requeryMs } = { ...DEFAULT_CONFIRM_OPTIONS, ...options }
	let waiters = rxWaiters.get(self)
	if (!waiters) {
		waiters = new Set()
		rxWaiters.set(self, waiters)
	}
	const registered = waiters

	return await new Promise<boolean>((resolve, reject) => {
		let reported = false
		const stop = () => {
			clearTimeout(deadline)
			leavePoll()
			registered.delete(waiter)
		}
		const waiter: RxWaiter = {
			onReport: (ip, report) => {
				if (ip !== wait.ip) return
				if (reportCovers(report, wait)) reported = true
				if (!wait.matches(reported)) return
				stop()
				resolve(true)
			},
			cancel: (error) => {
				stop()
				reject(error)
			},
		}
		const deadline = setTimeout(() => {
			stop()
			resolve(wait.matches(reported))
		}, timeoutMs)
		registered.add(waiter)
		const leavePoll = joinRxPoll(self, wait.ip, wait.query, requeryMs)
	})
}
