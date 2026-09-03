import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DANTE_CONST } from '../const.js'
import { parseSettingsReply, UPDATE_DEBOUNCE_MS, type DevicesData } from '../index.js'
import type DanteInstance from '../../main.js'

/**
 * Definition rebuilds are coalesced by `scheduleUpdateData` because each one re-serialises every
 * device's definitions to the Companion host - so the uncoalesced cost grows with the square of the
 * network. A settings reply carrying new option lists changes what the sample rate, pullup and
 * encoding dropdowns offer and so does need a rebuild, but discovery delivers a burst of them, one
 * per setting per device. Rebuilding on each reply bypassed the debounce entirely.
 */

const IP = '10.0.0.5'

function instance(): DanteInstance {
	return {
		devicesData: { [IP]: { name: 'DeviceA', ports: { ARC: 4440 } } } as DevicesData,
		devicesChoices: [{ id: 'DeviceA', label: 'DeviceA' }],
		txChannelsChoices: {},
		rxChannelsChoices: {},
		txFriendlyNameRefreshCounter: 0,
		counter: Buffer.from('0000', 'hex'),
		mac: Buffer.from('aabbccddeeff', 'hex'),
		sockets: {},
		debug: false,
		timeout: 0,
		config: { mac: 'x', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkFeedbacks: vi.fn(),
		checkFeedbacksById: vi.fn(),
		checkAllFeedbacks: vi.fn(),
		log: vi.fn(),
		updateStatus: vi.fn(),
	} as unknown as DanteInstance
}

/**
 * An encoding-status reply advertising `optionCount` supported encodings.
 *
 * Layout per `parseSettingsReply`: a 24-byte envelope, then a payload holding the command id at
 * offset 2, a pointer to the option list at 8, its length at 10, and the current value at 12.
 */
function encodingStatusReply(optionCount: number): Buffer {
	const optionsOffset = 64
	const payload = Buffer.alloc(optionsOffset + optionCount * 4)
	payload.writeUInt16BE(DANTE_CONST.COMMANDS.MESSAGE_TYPE_ENCODING_STATUS, 2)
	payload.writeUInt16BE(optionsOffset, 8)
	payload.writeUInt16BE(optionCount, 10)
	payload.writeUInt32BE(24, 12)
	for (let i = 0; i < optionCount; i++) payload.writeUInt32BE(16 + i * 8, optionsOffset + i * 4)

	const envelope = Buffer.alloc(24)
	envelope.writeUInt16BE(DANTE_CONST.PROTOCOL.SETTINGS, 0)
	envelope.writeUInt16BE(24 + payload.length, 2)
	return Buffer.concat([envelope, payload])
}

function deliver(self: DanteInstance, reply: Buffer) {
	parseSettingsReply(self, reply, { address: IP, size: reply.length } as never)
}

const rebuilds = (self: DanteInstance) => (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls.length

describe('settings replies carrying option lists', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('parses the option list this test builds, so the assertions below mean something', () => {
		const self = instance()
		deliver(self, encodingStatusReply(3))

		expect(self.devicesData[IP].encodingOptions).toHaveLength(3)
	})

	it('does not rebuild definitions synchronously', () => {
		const self = instance()
		deliver(self, encodingStatusReply(3))

		expect(rebuilds(self)).toBe(0)
	})

	it('rebuilds once the debounce settles', () => {
		const self = instance()
		deliver(self, encodingStatusReply(3))

		vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS)
		expect(rebuilds(self)).toBe(1)
	})

	it('coalesces a burst of replies into a single rebuild', () => {
		// discovery delivers one of these per setting per device
		const self = instance()
		for (let i = 0; i < 20; i++) deliver(self, encodingStatusReply(3 + (i % 2)))

		vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS)
		expect(rebuilds(self)).toBe(1)
	})

	it('rebuilds variables and feedbacks alongside actions, not actions alone', () => {
		// the option lists only affect actions, but going through the shared path keeps the three in
		// step - an action-only rebuild was what escaped the debounce in the first place
		const self = instance()
		deliver(self, encodingStatusReply(3))
		vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS)

		expect(self.setVariableDefinitions).toHaveBeenCalled()
		expect(self.setFeedbackDefinitions).toHaveBeenCalled()
	})

	it('does not rebuild at all when the reply carries no option list', () => {
		const self = instance()
		deliver(self, encodingStatusReply(0))

		vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS)
		expect(rebuilds(self)).toBe(0)
	})
})
