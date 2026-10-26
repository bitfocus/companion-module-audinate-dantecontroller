import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DANTE_CONST, parseReply, retryMissingAudioDirectories, type DevicesData } from '../index.js'
import type DanteInstance from '../../main.js'
import { ip } from '../../tests/ids.js'

/**
 * Re-asking for an audio directory that did not fully arrive.
 *
 * Some devices drop requests rather than queue them: a Neutrik NA2-D-LINE answers about the first
 * five of a burst and discards the rest without a reply. The burst after a reconnect is past that,
 * so a device could end up with channel counts and no names behind them - and its transmit names
 * are only re-read on a rename, so every receiver subscribed to it showed no source.
 */

const IP = ip('192.168.1.237')
const { MESSAGE_TYPE_TX_CHANNEL_QUERY, MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY, MESSAGE_TYPE_RX_CHANNEL_QUERY } =
	DANTE_CONST.COMMANDS

/** Longer than the window every channel query opens, during which a device is not re-asked. */
const PAST_SETTLING_MS = 3001

function instance(device: Record<string, unknown>): { self: DanteInstance; sent: Buffer[] } {
	const sent: Buffer[] = []
	const self = {
		devicesData: { [IP]: device } as unknown as DevicesData,
		debug: false,
		counter: Buffer.alloc(2),
		mac: Buffer.alloc(6),
		sockets: { ARC: { send: vi.fn((buffer: Buffer) => sent.push(Buffer.from(buffer))) } },
		log: vi.fn(),
		// what parsing a reply reaches: the variable and feedback pushes it schedules
		config: { variables: false, routingVariables: false },
		devicesChoices: [],
		txChannelsChoices: {},
		rxChannelsChoices: {},
		videoTxChannelsChoices: {},
		videoRxChannelsChoices: {},
		// a learnt channel list rebuilds the definitions
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkFeedbacks: vi.fn(),
		checkAllFeedbacks: vi.fn(),
	} as unknown as DanteInstance
	return { self, sent }
}

/** The opcodes of the queries a number of sweeps sent, a settling window apart. */
function sweep(self: DanteInstance, sent: Buffer[], times = 1): number[] {
	const before = sent.length
	for (let i = 0; i < times; i++) {
		retryMissingAudioDirectories(self)
		vi.advanceTimersByTime(PAST_SETTLING_MS)
	}
	return sent.slice(before).map((packet) => packet.readUInt16BE(6))
}

const named = { 1: { number: 1, name: '01 n/a' }, 2: { number: 2, name: '02 n/a' } }
const unnamed = { 1: { number: 1 }, 2: { number: 2 } }

/** A device with both directories complete. */
function complete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'IMAG-IO1',
		ports: { ARC: 4440 },
		audioTx: { count: 2, ...named },
		audioRx: { count: 2, ...named },
		...overrides,
	}
}

/** A friendly-names reply for two channels, as IMAG-IO1 sent it. */
function friendlyNamesReply(): Buffer {
	return Buffer.from('2729002a001b20100001020200010001001c000200020023001c00333031206e2f61003032206e2f6100', 'hex')
}

describe('retryMissingAudioDirectories', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('re-asks a device whose transmit names never arrived', () => {
		// the reconnect case: the counts reply was answered, the transmit query was dropped
		const { self, sent } = instance(complete({ audioTx: { count: 2 } }))
		expect(sweep(self, sent)).toEqual([MESSAGE_TYPE_TX_CHANNEL_QUERY, MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY])
	})

	it('re-asks for channels that are counted but not named', () => {
		const { self, sent } = instance(complete({ audioRx: { count: 2, ...unnamed } }))
		expect(sweep(self, sent)).toEqual([MESSAGE_TYPE_RX_CHANNEL_QUERY])
	})

	it('re-asks a device whose friendly-names query went unanswered', () => {
		const { self, sent } = instance(complete({ txFriendlyNamesPending: true }))
		expect(sweep(self, sent)).toEqual([MESSAGE_TYPE_TX_CHANNEL_QUERY, MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY])
	})

	it('stops once the friendly-names query is answered', () => {
		const { self, sent } = instance(complete({ txFriendlyNamesPending: true }))
		parseReply(self, friendlyNamesReply(), { address: IP, size: 42 } as never)
		expect(self.devicesData[IP]?.txFriendlyNamesPending).toBe(false)
		expect(sweep(self, sent, 10)).toEqual([])
	})

	it('leaves a complete device alone', () => {
		const { self, sent } = instance(complete())
		expect(sweep(self, sent, 10)).toEqual([])
	})

	it('leaves alone a device that has not reported its channel counts yet', () => {
		// the counts reply is what sends the first channel queries; there is nothing to chase before it
		const { self, sent } = instance({ name: 'IMAG-IO1', ports: { ARC: 4440 } })
		expect(sweep(self, sent, 10)).toEqual([])
	})

	it('does not add to a burst whose replies may still be on their way', () => {
		const { self, sent } = instance(complete({ audioTx: { count: 2 } }))
		retryMissingAudioDirectories(self)
		const first = sent.length
		// still inside the window the queries just opened
		vi.advanceTimersByTime(1000)
		retryMissingAudioDirectories(self)
		expect(sent.length).toBe(first)
	})

	it('waits until discovery has learned where to send the query', () => {
		const { self, sent } = instance(complete({ ports: {}, audioTx: { count: 2 } }))
		expect(sweep(self, sent, 5)).toEqual([])
	})

	it('gives up after a bounded number of attempts', () => {
		const { self, sent } = instance(complete({ audioTx: { count: 2 } }))
		// two queries an attempt, five attempts, and nothing after that however long it runs
		expect(sweep(self, sent, 50)).toHaveLength(10)
	})

	it('chases a directory again if it is lost after being complete', () => {
		const { self, sent } = instance(complete({ audioTx: { count: 2 } }))
		sweep(self, sent, 50)
		const device = self.devicesData[IP] as Record<string, unknown>

		// the names arrive late, which releases the spent budget
		device.audioTx = { count: 2, ...named }
		device.txFriendlyNamesPending = false
		expect(sweep(self, sent)).toEqual([])

		// and a later reconnect that loses them again is retried in full
		device.audioTx = { count: 2 }
		expect(sweep(self, sent)).toEqual([MESSAGE_TYPE_TX_CHANNEL_QUERY, MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY])
	})
})
