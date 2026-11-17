import type dgram from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import {
	awaitCommandAck,
	cancelPendingCommands,
	cancelUpdateData,
	clearAllAudioCrosspoints,
	DANTE_CONST,
	DanteCommandError,
	destroyDevice,
	handleCommandReply,
	makeAudioCrosspointConfirmed,
	clearAudioCrosspointConfirmed,
	cancelCheckFeedbacks,
	cancelCheckVariables,
	makeCommand,
	notifyRxStateChanged,
	parseReply,
	sendCommand,
	type DevicesData,
} from '../api/index.js'
import type DanteInstance from '../main.js'
import { ackFor, answeringSend, rxReply, type FakeAnswer } from './fake-device.js'
import { ch, ip, name } from './ids.js'

const DEST = ip('10.0.0.5')
const SOURCE = ip('10.0.0.6')
const AMP = name('Amp')
const STAGE = name('Stage Box')

/** Fast enough that every failure path finishes in a few tens of milliseconds. */
const FAST = { ack: { attemptTimeoutMs: 5, attempts: 3 }, confirm: { timeoutMs: 40, requeryMs: 10 } }
/** A confirmation timeout long enough that finishing well inside it shows the wait ended early. */
const SLOW = { ack: FAST.ack, confirm: { timeoutMs: 2000, requeryMs: 10 } }

function devicesData(): DevicesData {
	return {
		[DEST]: {
			name: name('Amp'),
			ports: { ARC: 4440 },
			audioRx: { count: 2, 1: { number: ch(1), name: 'Left' }, 2: { number: ch(2), name: 'Right' } },
		},
		[SOURCE]: {
			name: name('Stage Box'),
			ports: { ARC: 4440 },
			audioTx: {
				count: 2,
				1: { number: ch(1), name: '01', friendlyName: 'Mic 1' },
				2: { number: ch(2), name: '02' },
			},
		},
	}
}

/** An instance whose ARC socket is a fake device answering with `respond`. */
function instance(respond: (command: Buffer, ip: string) => FakeAnswer | undefined = () => undefined) {
	const self = {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, createVariables: [], verbose: false },
		devicesData: devicesData(),
		devicesChoices: [
			{ id: AMP, label: 'Amp' },
			{ id: STAGE, label: 'Stage Box' },
		],
		rxChannelsChoices: {
			[AMP]: [
				{ id: ch(1), label: 'Left' },
				{ id: ch(2), label: 'Right' },
			],
		},
		txChannelsChoices: {
			[STAGE]: [
				{ id: ch(1), label: 'Mic 1' },
				{ id: ch(2), label: '02' },
			],
		},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		counter: Buffer.from('0100', 'hex'),
		debug: false,
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkAllFeedbacks: vi.fn(),
		checkFeedbacks: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
	const send = answeringSend(self, respond)
	self.sockets = { ARC: { send } as unknown as dgram.Socket }
	return { self, send }
}

const isSubscribe = (command: Buffer) => command.readUInt16BE(6) === DANTE_CONST.COMMANDS.subscription
const isRxQuery = (command: Buffer) => command.readUInt16BE(6) === DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY

/** Applies a subscription to Amp's rx channel 1 the way the device would report it. */
function subscribe(self: DanteInstance, sourceChannel: string | undefined, subscriptionStatus: number) {
	return () => {
		self.devicesData[DEST].audioRx![1] = {
			number: ch(1),
			name: 'Left',
			sourceDevice: sourceChannel === undefined ? undefined : 'Stage Box',
			sourceChannel,
			subscriptionStatus,
		}
	}
}

const subscribes = (send: ReturnType<typeof vi.fn>) =>
	send.mock.calls.map((call) => call[0] as Buffer).filter((command) => isSubscribe(command))

describe('confirmed crosspoints', () => {
	it('resolves once the device accepts and reports the route connected', async () => {
		const { self, send } = instance((command) =>
			isSubscribe(command) ? { apply: subscribe(self, 'Mic 1', 0x0009) } : undefined,
		)

		await makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)

		expect(subscribes(send)).toHaveLength(1)
	})

	it('addresses the destination by an address saved by 1.x as well as by name', async () => {
		const { self, send } = instance((command) =>
			isSubscribe(command) ? { apply: subscribe(self, 'Mic 1', 0x0009) } : undefined,
		)

		await makeAudioCrosspointConfirmed(self, DEST, 'Mic 1', 'Stage Box', 1, FAST)

		expect(send.mock.calls[0][4]).toBe(DEST)
	})

	it('names the device it cannot reach', async () => {
		const { self } = instance()
		delete self.devicesData[DEST]

		await expect(makeAudioCrosspointConfirmed(self, AMP, 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			"Can't find Amp - it may be offline",
		)
	})

	it('fails with the result code when the device rejects the command', async () => {
		const { self } = instance((command) => (isSubscribe(command) ? { result: 0x8101 } : undefined))

		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 2, FAST)).rejects.toThrow(
			'Amp (10.0.0.5) rejected the change to audio channel 2 (result 0x8101)',
		)
	})

	it('resends a command the device does not answer, with the same transaction number', async () => {
		const { self, send } = instance()

		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			'Amp (10.0.0.5) did not answer, and audio channel 1 on Amp (10.0.0.5) does not show Mic 1@Stage Box',
		)

		const sent = subscribes(send)
		expect(sent).toHaveLength(3)
		expect(new Set(sent.map((command) => command.toString('hex'))).size).toBe(1)
	})

	it('still succeeds when the reply is lost but the channel shows the route', async () => {
		const { self } = instance((command) => {
			if (isSubscribe(command)) subscribe(self, 'Mic 1', 0x0009)()
			return isRxQuery(command) ? {} : undefined
		})

		await makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)
	})

	it('does not take what a silent device last reported for a confirmation', async () => {
		const { self } = instance()
		subscribe(self, 'Mic 1', 0x0009)()

		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			'Amp (10.0.0.5) did not answer, and audio channel 1 on Amp (10.0.0.5) does not show Mic 1@Stage Box',
		)
	})

	it('takes a parsed reply as a report on exactly the channels it carried', async () => {
		const { self } = instance()
		subscribe(self, 'Mic 1', 0x0009)()
		const deliver = (channel: { number: number; name: string }) => {
			const reply = rxReply([{ ...channel, source: 'Stage Box', channel: 'Mic 1', status: 0x0009 }])
			parseReply(self, reply, { address: DEST, family: 'IPv4', port: 4440, size: reply.length })
		}

		let confirmed = false
		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, SLOW).then(() => {
			confirmed = true
		})
		// past the three unanswered attempts, so only a reply carrying channel 1 can confirm it
		await new Promise((resolve) => setTimeout(resolve, 40))
		deliver({ number: 2, name: 'Right' })
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(confirmed).toBe(false)

		deliver({ number: 1, name: 'Left' })
		await route
		cancelCheckVariables(self)
		cancelCheckFeedbacks(self)
	})

	it('does not take a silent device clearing from what it last reported either', async () => {
		const { self } = instance()

		await expect(clearAudioCrosspointConfirmed(self, 'Amp', 1, FAST)).rejects.toThrow('did not answer')
	})

	it('does not confirm a clear by the device record having gone', async () => {
		const { self } = instance((command) => {
			if (!isSubscribe(command)) return undefined
			delete self.devicesData[DEST]
			return {}
		})
		subscribe(self, 'Mic 1', 0x0009)()

		await expect(clearAudioCrosspointConfirmed(self, 'Amp', 1, FAST)).rejects.toThrow('does not show no source')
	})

	it('fails a route still waiting on the channel when the connection closes', async () => {
		const { self } = instance((command) => (isSubscribe(command) ? {} : undefined))

		const started = Date.now()
		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, SLOW)
		setTimeout(() => cancelPendingCommands(self), 20)

		await expect(route).rejects.toThrow('Connection closed before the device answered')
		expect(Date.now() - started).toBeLessThan(SLOW.confirm.timeoutMs / 4)
	})

	it('fails when the device accepts but the channel never shows the route', async () => {
		const { self } = instance((command) => (isSubscribe(command) ? {} : undefined))

		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			'Amp (10.0.0.5) accepted the change, but audio channel 1 on Amp (10.0.0.5) does not show Mic 1@Stage Box',
		)
	})

	it.each([
		[0x0001, 'unresolved (0x0001)'],
		[0x001c, 'unsupported (0x001c)'],
	])('fails a route from an online source that does not connect (status %s)', async (status, label) => {
		const { self } = instance((command) =>
			isSubscribe(command) ? { apply: subscribe(self, 'Mic 1', status) } : undefined,
		)

		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			`is subscribed to Mic 1@Stage Box but not connected: ${label}`,
		)
	})

	it('fails a refused route as soon as a reply shows the refusal, not after the timeout', async () => {
		const { self } = instance((command) => {
			if (isSubscribe(command)) return { apply: subscribe(self, 'Mic 1', 0x001c) }
			return isRxQuery(command) ? {} : undefined
		})

		const started = Date.now()
		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, SLOW)).rejects.toThrow(
			'is subscribed to Mic 1@Stage Box but not connected: unsupported (0x001c)',
		)
		expect(Date.now() - started).toBeLessThan(SLOW.confirm.timeoutMs / 4)
	})

	it('does not fail on a refusal the channel reported before the route was sent', async () => {
		// An earlier attempt left the same subscription refused; the device then connects it
		const { self } = instance((command) => {
			if (isSubscribe(command)) return {}
			return isRxQuery(command) ? { apply: subscribe(self, 'Mic 1', 0x0009) } : undefined
		})
		subscribe(self, 'Mic 1', 0x001c)()

		await makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, SLOW)
	})

	it('does not fail on an old refusal when a reply carries only other channels', async () => {
		const { self } = instance((command) => (isSubscribe(command) ? {} : undefined))
		subscribe(self, 'Mic 1', 0x001c)()

		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, SLOW)
		setTimeout(() => notifyRxStateChanged(self, DEST, { mediaType: 'audio', channels: [2] }), 10)
		setTimeout(() => notifyRxStateChanged(self, DEST, { mediaType: 'video' }), 20)
		setTimeout(() => {
			subscribe(self, 'Mic 1', 0x0009)()
			notifyRxStateChanged(self, DEST, { mediaType: 'audio', channels: [1] })
		}, 40)

		await route
	})

	it('fails on a refusal in a reply that does carry the channel', async () => {
		const { self } = instance((command) => (isSubscribe(command) ? {} : undefined))
		subscribe(self, 'Mic 1', 0x001c)()

		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, SLOW)
		setTimeout(() => notifyRxStateChanged(self, DEST, { mediaType: 'audio', channels: [1, 2] }), 10)

		await expect(route).rejects.toThrow('not connected: unsupported (0x001c)')
	})

	it('keeps waiting while an online source is still unresolved', async () => {
		const { self } = instance((command) => {
			if (isSubscribe(command)) return { apply: subscribe(self, 'Mic 1', 0x0001) }
			return isRxQuery(command) ? {} : undefined
		})

		const started = Date.now()
		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			'not connected: unresolved (0x0001)',
		)
		expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.confirm.timeoutMs - 5)
	})

	it('finishes when an unresolved route connects, on the device announcing it', async () => {
		// A route that needs a new flow is reported unresolved (0x0001) at once and connected (0x0009)
		// about 150 ms later on Ultimo X2 hardware, announced by a change notification.
		const { self } = instance((command) =>
			isSubscribe(command)
				? {
						apply: () => {
							subscribe(self, 'Mic 1', 0x0001)()
							setTimeout(() => {
								subscribe(self, 'Mic 1', 0x0009)()
								notifyRxStateChanged(self, DEST)
							}, 150)
						},
					}
				: undefined,
		)

		const started = Date.now()
		await makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, SLOW)
		const elapsed = Date.now() - started
		expect(elapsed).toBeGreaterThanOrEqual(140)
		expect(elapsed).toBeLessThan(SLOW.confirm.timeoutMs / 2)
	})

	it('accepts a route to a source that is not on the network, which Dante resolves later', async () => {
		const { self } = instance((command) =>
			isSubscribe(command)
				? {
						apply: () => {
							self.devicesData[DEST].audioRx![1] = {
								number: ch(1),
								name: 'Left',
								sourceDevice: 'Spare Rack',
								sourceChannel: 'Out 1',
								subscriptionStatus: 0x0001,
							}
						},
					}
				: undefined,
		)

		await makeAudioCrosspointConfirmed(self, 'Amp', 'Out 1', 'Spare Rack', 1, FAST)
	})

	it('confirms a clear by the channel reporting no source', async () => {
		const { self } = instance((command) =>
			isSubscribe(command) ? { apply: subscribe(self, undefined, 0x0000) } : undefined,
		)
		subscribe(self, 'Mic 1', 0x0009)()

		await clearAudioCrosspointConfirmed(self, 'Amp', 1, FAST)
	})

	it('matches names case-insensitively, as Dante does', async () => {
		const { self } = instance((command) =>
			isSubscribe(command) ? { apply: subscribe(self, 'MIC 1', 0x0009) } : undefined,
		)

		await makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)
	})
})

describe('a salvo of routes to one receiver', () => {
	const channels = Object.fromEntries(
		Array.from({ length: 64 }, (_, index) => [index + 1, { number: ch(index + 1), name: `In ${index + 1}` }]),
	)
	/** Accepts every subscribe, and never shows one, so the routes re-query for the whole timeout. */
	function receiver() {
		const device = instance((command) => (isSubscribe(command) ? {} : undefined))
		device.self.devicesData[DEST].audioRx = { count: 64, ...channels }
		return device
	}
	const rxQueries = (send: ReturnType<typeof vi.fn>) =>
		send.mock.calls.map((call) => call[0] as Buffer).filter((command) => isRxQuery(command))
	/** The first channel of the page a query asks for. */
	const firstChannel = (command: Buffer) => command.readUInt16BE(12)

	it('re-queries a page once per tick, however many routes are waiting on it', async () => {
		const { self, send } = receiver()

		await Promise.allSettled(
			Array.from({ length: 16 }, async (_, index) =>
				makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', index + 1, FAST),
			),
		)

		const queries = rxQueries(send)
		expect(new Set(queries.map(firstChannel))).toEqual(new Set([1]))
		// the first one, then one per tick of the timeout
		expect(queries.length).toBeLessThanOrEqual(1 + FAST.confirm.timeoutMs / FAST.confirm.requeryMs + 1)
	})

	it('asks only for the pages holding the channels', async () => {
		const { self, send } = receiver()

		await Promise.allSettled([
			makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 20, FAST),
			makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 50, FAST),
		])

		expect(new Set(rxQueries(send).map(firstChannel))).toEqual(new Set([17, 49]))
	})

	it('stops querying once nothing is waiting', async () => {
		const { self, send } = receiver()
		await Promise.allSettled([makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)])

		const queries = rxQueries(send).length
		await new Promise((resolve) => setTimeout(resolve, FAST.confirm.requeryMs * 3))

		expect(rxQueries(send)).toHaveLength(queries)
	})
})

describe('an aborted action', () => {
	/** Waits long enough that only the abort can have ended them early. */
	const PATIENT = { ack: { attemptTimeoutMs: 1000, attempts: 3 }, confirm: { timeoutMs: 2000, requeryMs: 10 } }
	const later = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
	const rxQueries = (send: ReturnType<typeof vi.fn>) =>
		send.mock.calls.map((call) => call[0] as Buffer).filter((command) => isRxQuery(command))

	it('stops resending a command nobody wants any more, with the reason it was aborted', async () => {
		const { self, send } = instance()
		const controller = new AbortController()
		const reason = new Error('Actions aborted')

		const started = Date.now()
		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, {
			...PATIENT,
			signal: controller.signal,
		})
		setTimeout(() => controller.abort(reason), 20)

		await expect(route).rejects.toBe(reason)
		expect(Date.now() - started).toBeLessThan(PATIENT.ack.attemptTimeoutMs / 2)
		await later(50)
		expect(subscribes(send)).toHaveLength(1)
	})

	it('takes a reply that comes after the abort for nobody', async () => {
		const { self } = instance()
		const controller = new AbortController()
		const command = makeCommand(self, DANTE_CONST.COMMANDS.subscription, Buffer.from('0401', 'hex'))
		sendCommand(self, command, DEST)
		const ack = awaitCommandAck(self, DEST, command, PATIENT.ack, controller.signal)

		controller.abort()
		await expect(ack).rejects.toThrow('aborted')
		expect(handleCommandReply(self, ackFor(command), { address: DEST })).toBe(false)
	})

	it('stops polling the channel once the action is aborted', async () => {
		// accepted, and never shown, so the wait would poll for the whole timeout
		const { self, send } = instance((command) => (isSubscribe(command) ? {} : undefined))
		const controller = new AbortController()

		const started = Date.now()
		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, {
			...PATIENT,
			signal: controller.signal,
		})
		setTimeout(() => controller.abort(), 30)

		await expect(route).rejects.toThrow('aborted')
		expect(Date.now() - started).toBeLessThan(PATIENT.confirm.timeoutMs / 4)
		const queries = rxQueries(send).length
		await later(PATIENT.confirm.requeryMs * 5)
		expect(rxQueries(send)).toHaveLength(queries)
	})

	it('sends nothing for an action aborted before it ran', async () => {
		const { self, send } = instance()
		const controller = new AbortController()
		controller.abort()

		await expect(
			makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, { ...PATIENT, signal: controller.signal }),
		).rejects.toThrow('aborted')
		expect(send).not.toHaveBeenCalled()
	})

	it('stops a clear of every channel at the batch it is on', async () => {
		const isRemove = (command: Buffer) => command.readUInt16BE(6) === DANTE_CONST.COMMANDS.subscriptionRemove
		// four batches of sixteen routed channels, each batch accepted and never shown cleared
		const { self, send } = instance((command) => (isRemove(command) ? {} : undefined))
		const routed = (number: number) => ({
			number: ch(number),
			name: `In ${number}`,
			sourceDevice: 'Stage Box',
			sourceChannel: 'Mic 1',
			subscriptionStatus: 0x0009,
		})
		self.devicesData[DEST].audioRx = {
			count: 64,
			...Object.fromEntries(Array.from({ length: 64 }, (_, index) => [index + 1, routed(index + 1)])),
		}
		const controller = new AbortController()
		const reason = new Error('Actions aborted')

		const clear = clearAllAudioCrosspoints(self, 'Amp', { ...PATIENT, signal: controller.signal })
		setTimeout(() => controller.abort(reason), 20)

		// the reason itself, not a report of four failed batches
		await expect(clear).rejects.toBe(reason)
		await later(50)
		expect(send.mock.calls.filter((call) => isRemove(call[0] as Buffer))).toHaveLength(1)
	})
})

describe('a device that goes offline', () => {
	/** Waits long enough that only the device going can have ended them early. */
	const PATIENT = { ack: { attemptTimeoutMs: 1000, attempts: 3 }, confirm: { timeoutMs: 2000, requeryMs: 10 } }
	const later = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
	/** Times a device out, as its offline timer does. */
	function goOffline(self: DanteInstance, deviceIp: typeof DEST) {
		destroyDevice(self, deviceIp)
		// the definitions rebuild it schedules has nothing to run against here
		cancelUpdateData(self)
	}

	it('fails a route waiting on the channel at once, naming the device', async () => {
		// accepted, and never shown, so the wait would run its whole timeout
		const { self } = instance((command) => (isSubscribe(command) ? {} : undefined))

		const started = Date.now()
		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, PATIENT)
		setTimeout(() => goOffline(self, DEST), 20)

		// a command error, so Companion shows the action failing with this message
		await expect(route).rejects.toBeInstanceOf(DanteCommandError)
		await expect(route).rejects.toThrow(/^Amp \(10\.0\.0\.5\) went offline before it confirmed the change$/)
		expect(Date.now() - started).toBeLessThan(PATIENT.confirm.timeoutMs / 4)
	})

	it('fails a command still waiting on its answer at once, and stops resending it', async () => {
		const { self, send } = instance()

		const started = Date.now()
		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, PATIENT)
		setTimeout(() => goOffline(self, DEST), 20)

		await expect(route).rejects.toThrow('went offline')
		expect(Date.now() - started).toBeLessThan(PATIENT.ack.attemptTimeoutMs / 2)
		expect(subscribes(send)).toHaveLength(1)
	})

	it('leaves waits on other devices alone', async () => {
		const { self } = instance((command) => (isSubscribe(command) ? {} : undefined))

		const route = makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, PATIENT)
		// the source goes, then the destination reports the route it was asked for
		setTimeout(() => goOffline(self, SOURCE), 10)
		setTimeout(() => {
			subscribe(self, 'Mic 1', 0x0001)()
			notifyRxStateChanged(self, DEST, { mediaType: 'audio', channels: [1] })
		}, 30)

		// a source that is not on the network is a pre-patch, confirmed by the subscription alone
		await expect(route).resolves.toBeUndefined()
	})

	it('does not take a device for one whose address it starts with', async () => {
		const { self } = instance()
		const command = makeCommand(self, DANTE_CONST.COMMANDS.subscription, Buffer.from('0401', 'hex'))
		const ack = awaitCommandAck(self, ip('10.0.0.50'), command, { attemptTimeoutMs: 30, attempts: 1 })

		goOffline(self, DEST)
		await expect(ack).resolves.toEqual({ kind: 'unanswered' })
	})

	it('stops a clear of every channel there, rather than trying the rest', async () => {
		const isRemove = (command: Buffer) => command.readUInt16BE(6) === DANTE_CONST.COMMANDS.subscriptionRemove
		// four batches of sixteen routed channels, each accepted and never shown cleared
		const { self, send } = instance((command) => (isRemove(command) ? {} : undefined))
		const routed = (number: number) => ({
			number: ch(number),
			name: `In ${number}`,
			sourceDevice: 'Stage Box',
			sourceChannel: 'Mic 1',
			subscriptionStatus: 0x0009,
		})
		self.devicesData[DEST].audioRx = {
			count: 64,
			...Object.fromEntries(Array.from({ length: 64 }, (_, index) => [index + 1, routed(index + 1)])),
		}

		const started = Date.now()
		const clear = clearAllAudioCrosspoints(self, 'Amp', PATIENT)
		setTimeout(() => goOffline(self, DEST), 20)

		// one message for the device, not one for every batch left
		await expect(clear).rejects.toThrow(
			new DanteCommandError('Amp (10.0.0.5) went offline before it confirmed the change'),
		)
		expect(Date.now() - started).toBeLessThan(PATIENT.confirm.timeoutMs / 4)
		await later(50)
		expect(send.mock.calls.filter((call) => isRemove(call[0] as Buffer))).toHaveLength(1)
	})
})

describe('awaitCommandAck', () => {
	function sent(self: DanteInstance) {
		const command = makeCommand(self, DANTE_CONST.COMMANDS.subscription, Buffer.from('0401', 'hex'))
		sendCommand(self, command, DEST)
		return command
	}

	it('ignores a reply with the right transaction number from another device', async () => {
		const { self } = instance()
		const command = sent(self)
		const ack = awaitCommandAck(self, DEST, command, { attemptTimeoutMs: 5, attempts: 1 })

		expect(handleCommandReply(self, ackFor(command), { address: SOURCE })).toBe(false)
		await expect(ack).resolves.toEqual({ kind: 'unanswered' })
	})

	it('accepts a longer reply, as a channel rename gets', async () => {
		const { self } = instance()
		const command = sent(self)
		const ack = awaitCommandAck(self, DEST, command)

		expect(handleCommandReply(self, Buffer.concat([ackFor(command), Buffer.alloc(2)]), { address: DEST })).toBe(true)
		await expect(ack).resolves.toEqual({ kind: 'accepted', code: 0x0001 })
	})

	it('resends after a send error, as after a lost reply', async () => {
		const { self, send } = instance((command) =>
			isSubscribe(command) ? { apply: subscribe(self, 'Mic 1', 0x0009) } : undefined,
		)
		// as dgram does: the callback runs after send returns
		send.mockImplementationOnce((...args: unknown[]) =>
			queueMicrotask(() => (args[5] as (error: Error) => void)(new Error('ENOBUFS'))),
		)

		await makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)

		expect(subscribes(send)).toHaveLength(2)
	})

	it('names the send error when nothing else confirms the route', async () => {
		const { self } = instance()
		;(self.sockets.ARC as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn((...args: unknown[]) =>
			queueMicrotask(() => (args[5] as (error: Error) => void)(new Error('EHOSTUNREACH'))),
		)

		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			'did not answer, and audio channel 1 on Amp (10.0.0.5) does not show Mic 1@Stage Box ' +
				'(could not send to 10.0.0.5: EHOSTUNREACH)',
		)
	})

	it('fails waiting commands when the connection closes', async () => {
		const { self } = instance()
		const command = sent(self)
		const ack = awaitCommandAck(self, DEST, command)

		cancelPendingCommands(self)
		await expect(ack).rejects.toThrow('Connection closed before the device answered')
	})
})
