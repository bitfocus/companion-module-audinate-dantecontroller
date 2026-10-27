import type dgram from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import {
	awaitCommandAck,
	cancelPendingCommands,
	DANTE_CONST,
	handleCommandReply,
	makeAudioCrosspointConfirmed,
	clearAudioCrosspointConfirmed,
	makeCommand,
	notifyRxStateChanged,
	sendCommand,
	type DevicesData,
} from '../api/index.js'
import type DanteInstance from '../main.js'
import { ackFor, answeringSend, type FakeAnswer } from './fake-device.js'
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
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: false, verbose: false },
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
			return undefined
		})

		await makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)
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

	it('fails a command that could not be sent', async () => {
		const { self } = instance()
		;(self.sockets.ARC as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn(
			// as dgram does: the callback runs after send returns
			(...args: unknown[]) => queueMicrotask(() => (args[5] as (error: Error) => void)(new Error('EHOSTUNREACH'))),
		)

		await expect(makeAudioCrosspointConfirmed(self, 'Amp', 'Mic 1', 'Stage Box', 1, FAST)).rejects.toThrow(
			'Could not send to 10.0.0.5: EHOSTUNREACH',
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
