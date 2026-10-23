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
	rememberTxChannelNames,
	resolveSubscriptionSource,
	sendCommand,
	type DevicesData,
} from '../api/index.js'
import type DanteInstance from '../main.js'
import { CheckVariables, UpdateVariableDefinitions } from '../variables.js'
import { ackFor, answeringSend, type FakeAnswer } from './fake-device.js'

const DEST = '10.0.0.5'
const SOURCE = '10.0.0.6'

/** Fast enough that every failure path finishes in a few tens of milliseconds. */
const FAST = { ack: { attemptTimeoutMs: 5, attempts: 3 }, confirm: { timeoutMs: 40, requeryMs: 10 } }

function devicesData(): DevicesData {
	return {
		[DEST]: {
			name: 'Amp',
			ports: { ARC: 4440 },
			audioRx: { count: 2, 1: { number: 1, name: 'Left' }, 2: { number: 2, name: 'Right' } },
		},
		[SOURCE]: {
			name: 'Stage Box',
			ports: { ARC: 4440 },
			audioTx: { count: 2, 1: { number: 1, name: '01', friendlyName: 'Mic 1' }, 2: { number: 2, name: '02' } },
		},
	}
}

/** An instance whose ARC socket is a fake device answering with `respond`. */
function instance(respond: (command: Buffer, ip: string) => FakeAnswer | undefined = () => undefined) {
	const self = {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: false, verbose: false },
		devicesData: devicesData(),
		devicesChoices: [
			{ id: 'Amp', label: 'Amp' },
			{ id: 'Stage Box', label: 'Stage Box' },
		],
		rxChannelsChoices: {
			Amp: [
				{ id: 1, label: 'Left' },
				{ id: 2, label: 'Right' },
			],
		},
		txChannelsChoices: {
			'Stage Box': [
				{ id: 1, label: 'Mic 1' },
				{ id: 2, label: '02' },
			],
		},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		deviceIdsByName: { Amp: '001dc1fffe000001', 'Stage Box': '001dc1fffe000002' },
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

/** Applies a subscription to Amp's rx channel 1 the way the device would report it. */
function subscribe(self: DanteInstance, sourceChannel: string | undefined, subscriptionStatus: number) {
	return () => {
		self.devicesData[DEST].audioRx![1] = {
			number: 1,
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

	it('accepts a route to a source that is not on the network, which Dante resolves later', async () => {
		const { self } = instance((command) =>
			isSubscribe(command)
				? {
						apply: () => {
							self.devicesData[DEST].audioRx![1] = {
								number: 1,
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

describe('source ids', () => {
	function withHistory() {
		const { self } = instance()
		rememberTxChannelNames(self, SOURCE)
		return self
	}

	it('resolves a subscription to the device id and transmit channel number', () => {
		const self = withHistory()
		expect(resolveSubscriptionSource(self, { deviceName: 'Stage Box', channelName: 'Mic 1' }, 'audio')).toBe(
			'001dc1fffe000002/1',
		)
		// the factory name a subscription may predate the friendly name with
		expect(resolveSubscriptionSource(self, { deviceName: 'stage box', channelName: '01' }, 'audio')).toBe(
			'001dc1fffe000002/1',
		)
	})

	it('still resolves the names a receiver kept after the transmitter was renamed', () => {
		const self = withHistory()
		// device rename: the id stays and the old name stays mapped to it
		self.devicesData[SOURCE].name = 'Stage Box B'
		self.deviceIdsByName['Stage Box B'] = '001dc1fffe000002'
		// channel rename
		self.devicesData[SOURCE].audioTx![2] = { number: 2, name: 'PROBE-TX' }
		rememberTxChannelNames(self, SOURCE)

		expect(resolveSubscriptionSource(self, { deviceName: 'Stage Box', channelName: '02' }, 'audio')).toBe(
			'001dc1fffe000002/2',
		)
		expect(resolveSubscriptionSource(self, { deviceName: 'Stage Box B', channelName: 'PROBE-TX' }, 'audio')).toBe(
			'001dc1fffe000002/2',
		)
	})

	it('prefers where a name is now over where it used to be', () => {
		const self = withHistory()
		self.devicesData[SOURCE].audioTx![1] = { number: 1, name: '02' }
		self.devicesData[SOURCE].audioTx![2] = { number: 2, name: 'Spare' }
		expect(resolveSubscriptionSource(self, { deviceName: 'Stage Box', channelName: '02' }, 'audio')).toBe(
			'001dc1fffe000002/1',
		)
	})

	it('is undefined for a device or channel it has never seen', () => {
		const self = withHistory()
		expect(resolveSubscriptionSource(self, { deviceName: 'Spare Rack', channelName: 'Mic 1' }, 'audio')).toBeUndefined()
		expect(resolveSubscriptionSource(self, { deviceName: 'Stage Box', channelName: 'Nope' }, 'audio')).toBeUndefined()
	})

	it("updates another device's source id variable when the source's channels change", () => {
		const { self } = instance()
		subscribe(self, 'Mic 1', 0x0009)()
		UpdateVariableDefinitions(self)
		CheckVariables(self)
		const values = (self.setVariableValues as ReturnType<typeof vi.fn>).mock.calls
		expect(values[0][0]).toMatchObject({ Amp_rx_1_source_id: '001dc1fffe000002/1' })

		// Mic 1 moves to channel 2 on the source: only Amp's source id changes
		self.devicesData[SOURCE].audioTx![1] = { number: 1, name: '01' }
		self.devicesData[SOURCE].audioTx![2] = { number: 2, name: '02', friendlyName: 'Mic 1' }
		CheckVariables(self, SOURCE, 'tx_names')

		expect(values.at(-1)?.[0]).toEqual({
			Amp_rx_1_source_id: '001dc1fffe000002/2',
			Stage_Box_tx_1_name: '01',
			Stage_Box_tx_2_name: 'Mic 1',
		})
	})
})
