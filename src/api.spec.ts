import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { InstanceStatus, type LoggingSink } from '@companion-module/base'
import type dgram from 'node:dgram'
import {
	intToBuffer,
	bufferToInt,
	incrementBE,
	parseString,
	parseStringAtPointer,
	getChannelSubscriptionName,
	hasRxChannels,
	hasTxChannels,
	findDeviceIpByName,
	findTxChannelByName,
	findRxChannelByName,
	checkConnections,
	registerDevice,
	destroyDevice,
	keepAlive,
	clearDeviceTimeouts,
	scheduleUpdateData,
	scheduleCheckVariables,
	cancelCheckVariables,
	scheduleCheckFeedbacks,
	cancelCheckFeedbacks,
	trackFeedbackDevices,
	untrackFeedback,
	cancelUpdateData,
	flushUpdateData,
	sendCommand,
	makeCommand,
	makeSettingCommand,
	setChannelName,
	makeCrosspoint,
	clearCrosspoint,
	clearAllCrosspoints,
	macForDevice,
	resolveDeviceIp,
	deviceByIdentifier,
	updateChannelChoices,
	getRxChannels,
	getTxChannels,
	firstChoiceId,
	currentChoiceId,
	parseHeartbeatReply,
	parseCmcReply,
	parseReply,
	parseSettingsReply,
	type DevicesData,
} from './api.js'
import { DANTE_CONST } from './const.js'
import type DanteInstance from './main.js'

// Real packets captured from a live Dante network during development, used to exercise
// the protocol/size/magic-string checks and byte-offset parsing against genuine data
// rather than only hand-built synthetic buffers.
const REAL_HEARTBEAT_HEX =
	'fffe005426900000001dc1fffe2c87d6417564696e617465000800011000000000348000000400040cd0000000100000000200100005b0c100000ad00000000000000000000007d6000000000000000000000000'
const REAL_SETTINGS_HEX =
	'ffff0034051f0000001dc1fffe2c87d6417564696e617465073d008000000000001800010000bb800000bb80000100000000bb80'
const REAL_CMC_HEX = '120000280010100100010000001dc1fffe2c87d600020000a9fe78b721fc0000ac1f78b821fc0000'
const REAL_ARC_HEX = '2729001c000b20000001020000000000000000000000000000000000'
const REAL_DEVICE_IP = '169.254.120.183'

// api.ts logs through its own module-level logger (createModuleLogger), not self.log.
// That logger checks global.COMPANION_LOGGER fresh on every call, so a spy installed here
// catches log calls from code under test without needing to recreate the logger instance.
let loggerSink: ReturnType<typeof vi.fn<LoggingSink>>

beforeEach(() => {
	loggerSink = vi.fn<LoggingSink>()
	global.COMPANION_LOGGER = loggerSink
})

afterEach(() => {
	global.COMPANION_LOGGER = undefined
})

function makeRinfo(address: string, size: number): dgram.RemoteInfo {
	return { address, size, port: 0, family: 'IPv4' }
}

function createMockInstance(overrides: Partial<DanteInstance> & { devicesData?: DevicesData } = {}): DanteInstance {
	const base = {
		devicesData: {},
		sockets: {},
		devicesChoices: [],
		txChannelsChoices: {},
		rxChannelsChoices: {},
		txFriendlyNameRefreshCounter: 0,
		counter: Buffer.from('0000', 'hex'),
		mac: Buffer.from('aabbccddeeff', 'hex'),
		debug: false,
		timeout: 3000,
		activeConnections: {},
		configError: null,
		CONNECTED: false,
		INTERVAL: null,
		mdns: { query: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn(), destroy: vi.fn() },
		config: { ip: '', interval: 1000, timeoutInterval: 3000, verbose: false },
		log: vi.fn(),
		updateStatus: vi.fn(),
		checkFeedbacks: vi.fn(),
		checkFeedbacksById: vi.fn(),
		checkAllFeedbacks: vi.fn(),
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		...overrides,
	}
	return base as unknown as DanteInstance
}

describe('intToBuffer', () => {
	it('encodes a 2-byte big-endian value by default', () => {
		expect(intToBuffer(0x1234)).toEqual(Buffer.from('1234', 'hex'))
	})

	it('encodes a single byte', () => {
		expect(intToBuffer(0x42, 1)).toEqual(Buffer.from('42', 'hex'))
	})

	it('encodes a 4-byte value', () => {
		expect(intToBuffer(0x01020304, 4)).toEqual(Buffer.from('01020304', 'hex'))
	})

	it('right-aligns an odd byte width into the last 2 bytes', () => {
		expect(intToBuffer(0x00ab, 3)).toEqual(Buffer.from('0000ab', 'hex'))
	})
})

describe('bufferToInt', () => {
	it('decodes a 2-byte big-endian value by default', () => {
		expect(bufferToInt(Buffer.from('1234', 'hex'))).toBe(0x1234)
	})

	it('decodes a single byte', () => {
		expect(bufferToInt(Buffer.from('42', 'hex'), 0, 1)).toBe(0x42)
	})

	it('decodes a 4-byte value', () => {
		expect(bufferToInt(Buffer.from('01020304', 'hex'), 0, 4)).toBe(0x01020304)
	})

	it('reads from a non-zero offset', () => {
		expect(bufferToInt(Buffer.from('ffff1234', 'hex'), 2)).toBe(0x1234)
	})

	it('round-trips with intToBuffer', () => {
		expect(bufferToInt(intToBuffer(0xabcd, 2), 0, 2)).toBe(0xabcd)
	})
})

describe('incrementBE', () => {
	it('increments the least significant byte', () => {
		const buf = Buffer.from('0000', 'hex')
		incrementBE(buf)
		expect(buf).toEqual(Buffer.from('0001', 'hex'))
	})

	it('carries into the next byte on overflow', () => {
		const buf = Buffer.from('00ff', 'hex')
		incrementBE(buf)
		expect(buf).toEqual(Buffer.from('0100', 'hex'))
	})

	it('wraps around when the whole buffer overflows', () => {
		const buf = Buffer.from('ffff', 'hex')
		incrementBE(buf)
		expect(buf).toEqual(Buffer.from('0000', 'hex'))
	})
})

describe('parseStringAtPointer', () => {
	const packet = Buffer.concat([Buffer.from('2729', 'hex'), Buffer.from('Talkback\u0000', 'utf8')])

	it('reads the string a non-zero pointer refers to', () => {
		expect(parseStringAtPointer(packet, 2)).toBe('Talkback')
	})

	it('treats a zero pointer as absent rather than reading the packet header', () => {
		// an unrouted rx channel has a zero source pointer; dereferencing it yielded "')"
		expect(parseStringAtPointer(packet, 0)).toBeUndefined()
	})

	it('treats a pointer past the end of the packet as absent', () => {
		expect(parseStringAtPointer(packet, 999)).toBeUndefined()
	})
})

describe('parseString', () => {
	it('decodes a NUL-terminated UTF-8 string', () => {
		const buf = Buffer.concat([Buffer.from('Hello', 'utf8'), Buffer.from([0x00]), Buffer.from('trailing')])
		// offset 0 is a valid fixed offset here - only packet-supplied *pointers* treat 0 as absent,
		// which is what parseStringAtPointer is for
		expect(parseString(buf, 0)).toBe('Hello')
	})

	it('runs to the end of the buffer when there is no terminator', () => {
		expect(parseString(Buffer.from('Hello', 'utf8'), 0)).toBe('Hello')
	})

	it('returns undefined for an offset past the end', () => {
		expect(parseString(Buffer.from('Hello', 'utf8'), 99)).toBeUndefined()
	})

	it('returns undefined when startIndex is past the end of the buffer', () => {
		expect(parseString(Buffer.from('Hi', 'utf8'), 10)).toBeUndefined()
	})
})

describe('getChannelSubscriptionName', () => {
	it('prefers the friendly name over the plain name', () => {
		expect(getChannelSubscriptionName({ friendlyName: 'Mic 1', name: 'Input 1' })).toBe('Mic 1')
	})

	it('falls back to the plain name when there is no friendly name', () => {
		expect(getChannelSubscriptionName({ name: 'Input 1' })).toBe('Input 1')
	})

	it('returns undefined for an undefined channel', () => {
		expect(getChannelSubscriptionName(undefined)).toBeUndefined()
	})
})

describe('hasRxChannels / hasTxChannels', () => {
	it('is true when the device has a positive channel count', () => {
		expect(hasRxChannels({ rx: { count: 2 } })).toBe(true)
		expect(hasTxChannels({ tx: { count: 1 } })).toBe(true)
	})

	it('is false when the count is zero, missing, or the device is undefined', () => {
		expect(hasRxChannels({ rx: { count: 0 } })).toBe(false)
		expect(hasRxChannels({})).toBe(false)
		expect(hasRxChannels(undefined)).toBe(false)
		expect(hasTxChannels({})).toBe(false)
	})
})

describe('findDeviceIpByName / findTxChannelByName / findRxChannelByName', () => {
	function createSelfWithDevice(): DanteInstance {
		return createMockInstance({
			devicesData: {
				'10.0.0.5': {
					name: 'MyDevice',
					tx: { 1: { number: 1, name: 'Input 1' }, 2: { number: 2, name: 'Input 2', friendlyName: 'Mic 2' }, count: 2 },
					rx: { 1: { number: 1, name: 'Output 1' }, count: 1 },
				},
			},
		})
	}

	it('finds a device ip by name', () => {
		expect(findDeviceIpByName(createSelfWithDevice(), 'MyDevice')).toBe('10.0.0.5')
	})

	it('returns undefined for an unknown device name', () => {
		expect(findDeviceIpByName(createSelfWithDevice(), 'Nope')).toBeUndefined()
	})

	it('finds a tx channel by name, identified by ip', () => {
		expect(findTxChannelByName(createSelfWithDevice(), '10.0.0.5', 'Input 1')?.number).toBe(1)
	})

	it('finds a tx channel by friendly name, identified by device name', () => {
		expect(findTxChannelByName(createSelfWithDevice(), 'MyDevice', 'Mic 2')?.number).toBe(2)
	})

	it('finds an rx channel by name', () => {
		expect(findRxChannelByName(createSelfWithDevice(), '10.0.0.5', 'Output 1')?.number).toBe(1)
	})

	it('does not mistake the count property for a channel', () => {
		expect(findTxChannelByName(createSelfWithDevice(), '10.0.0.5', 'Nonexistent')).toBeUndefined()
	})
})

describe('checkConnections', () => {
	it('returns true without updating status when already connected and all services active', () => {
		const self = createMockInstance({
			activeConnections: { ARC: true, CMC: true, SETTINGS: true, HEARTBEAT: true, MDNS: true },
			CONNECTED: true,
		})
		expect(checkConnections(self)).toBe(true)
		expect(self.updateStatus).not.toHaveBeenCalled()
	})

	it('transitions to Ok when all services become active', () => {
		const self = createMockInstance({
			activeConnections: { ARC: true, CMC: true, SETTINGS: true, HEARTBEAT: true, MDNS: true },
			CONNECTED: false,
		})
		expect(checkConnections(self)).toBe(true)
		expect(self.CONNECTED).toBe(true)
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.Ok)
	})

	it('returns false and transitions to Disconnected when a service is inactive', () => {
		const self = createMockInstance({
			activeConnections: { ARC: true, CMC: false, SETTINGS: true, HEARTBEAT: true },
			CONNECTED: true,
		})
		expect(checkConnections(self)).toBe(false)
		expect(self.CONNECTED).toBe(false)
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.Disconnected)
	})

	it('returns false and transitions to Disconnected when mDNS is inactive', () => {
		const self = createMockInstance({
			activeConnections: { ARC: true, CMC: true, SETTINGS: true, HEARTBEAT: true, MDNS: false },
			CONNECTED: true,
		})
		expect(checkConnections(self)).toBe(false)
		expect(self.CONNECTED).toBe(false)
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.Disconnected)
	})

	it('reports BadConfig instead of Ok when the configured interface is unusable', () => {
		const self = createMockInstance({
			activeConnections: { ARC: true, CMC: true, SETTINGS: true, HEARTBEAT: true, MDNS: true },
			CONNECTED: false,
			configError: 'No network interface selected',
		})
		expect(checkConnections(self)).toBe(true)
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.BadConfig, 'No network interface selected')
		expect(self.updateStatus).not.toHaveBeenCalledWith(InstanceStatus.Ok)
	})

	it('reports Ok once the interface problem is cleared', () => {
		const self = createMockInstance({
			activeConnections: { ARC: true, CMC: true, SETTINGS: true, HEARTBEAT: true, MDNS: true },
			CONNECTED: false,
			configError: null,
		})
		checkConnections(self)
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.Ok)
	})

	it('returns false without updating status when already disconnected', () => {
		const self = createMockInstance({ activeConnections: {}, CONNECTED: false })
		expect(checkConnections(self)).toBe(false)
		expect(self.updateStatus).not.toHaveBeenCalled()
	})
})

describe('registerDevice / destroyDevice / keepAlive', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('registers the device with the given name and adds it to devicesChoices', () => {
		const self = createMockInstance()
		registerDevice(self, '10.0.0.5', 'MyDevice')
		expect(self.devicesData['10.0.0.5']?.name).toBe('MyDevice')
		// choices are keyed by device name, which survives an address change
		expect(self.devicesChoices).toContainEqual({ id: 'MyDevice', label: 'MyDevice' })
	})

	it('arms an offline-destroy timeout when self.timeout > 0', () => {
		const self = createMockInstance({ timeout: 3000 })
		registerDevice(self, '10.0.0.5', 'MyDevice')
		expect(self.devicesData['10.0.0.5']?.timeoutArray).toBeDefined()
	})

	it('does not arm a timeout when self.timeout is 0', () => {
		const self = createMockInstance({ timeout: 0 })
		registerDevice(self, '10.0.0.5', 'MyDevice')
		expect(self.devicesData['10.0.0.5']?.timeoutArray).toBeUndefined()
	})

	it('destroys the device automatically once the timeout elapses without a keepAlive', () => {
		const self = createMockInstance({ timeout: 3000 })
		registerDevice(self, '10.0.0.5', 'MyDevice')
		vi.advanceTimersByTime(3000)
		expect(self.devicesData['10.0.0.5']).toBeUndefined()
		expect(self.devicesChoices).toEqual([])
	})

	it('keepAlive resets the destroy timer, keeping the device alive past the original deadline', () => {
		const self = createMockInstance({ timeout: 3000 })
		registerDevice(self, '10.0.0.5', 'MyDevice')

		vi.advanceTimersByTime(2000)
		keepAlive(self, '10.0.0.5')
		vi.advanceTimersByTime(2000) // 4000ms since registration, but only 2000ms since the keepAlive reset
		expect(self.devicesData['10.0.0.5']).toBeDefined()

		vi.advanceTimersByTime(1000) // 3000ms since the keepAlive reset
		expect(self.devicesData['10.0.0.5']).toBeUndefined()
	})

	it('keepAlive is a no-op for a device with no armed timeout', () => {
		const self = createMockInstance()
		expect(() => keepAlive(self, '10.0.0.5')).not.toThrow()
	})

	it('destroyDevice removes the device from devicesData and devicesChoices immediately', () => {
		const self = createMockInstance()
		registerDevice(self, '10.0.0.5', 'MyDevice')
		destroyDevice(self, '10.0.0.5')
		expect(self.devicesData['10.0.0.5']).toBeUndefined()
		expect(self.devicesChoices).toEqual([])
	})

	it('clearDeviceTimeouts disarms the pending offline timeout', () => {
		const self = createMockInstance({ timeout: 3000 })
		registerDevice(self, '10.0.0.5', 'MyDevice')

		clearDeviceTimeouts(self)
		vi.advanceTimersByTime(10000)

		expect(self.devicesData['10.0.0.5']).toBeDefined()
	})

	it('a re-init that clears timeouts does not later destroy a re-registered device', () => {
		const self = createMockInstance({ timeout: 3000 })
		registerDevice(self, '10.0.0.5', 'MyDevice')

		// what initConnection does on re-init: disarm the old timers, then drop the device table
		clearDeviceTimeouts(self)
		self.devicesData = {}
		self.devicesChoices = []

		// discovery immediately re-finds the same device
		registerDevice(self, '10.0.0.5', 'MyDevice')
		keepAlive(self, '10.0.0.5')

		// the timer armed before the re-init must not reach across and delete the live entry
		vi.advanceTimersByTime(2999)
		expect(self.devicesData['10.0.0.5']).toBeDefined()
		// choices are keyed by device name, which survives an address change
		expect(self.devicesChoices).toContainEqual({ id: 'MyDevice', label: 'MyDevice' })
	})
})

describe('scheduleUpdateData', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('coalesces a burst of requests into a single rebuild', () => {
		const self = createMockInstance()
		for (let i = 0; i < 50; i++) scheduleUpdateData(self)

		expect(self.setActionDefinitions).not.toHaveBeenCalled()
		vi.advanceTimersByTime(500)
		expect(self.setActionDefinitions).toHaveBeenCalledTimes(1)
	})

	it('does not rebuild while requests keep arriving inside the debounce window', () => {
		const self = createMockInstance()
		for (let i = 0; i < 9; i++) {
			scheduleUpdateData(self)
			vi.advanceTimersByTime(400) // 3.6s elapsed, never a quiet 500ms
		}
		expect(self.setActionDefinitions).not.toHaveBeenCalled()
	})

	it('rebuilds anyway once maxWait elapses under sustained load', () => {
		const self = createMockInstance()
		// a steady stream that never leaves a 500ms gap, as during discovery on a large network
		for (let i = 0; i < 40; i++) {
			scheduleUpdateData(self)
			vi.advanceTimersByTime(400)
		}
		// 16s of sustained requests must have produced rebuilds via the 10s maxWait
		expect(self.setActionDefinitions).toHaveBeenCalled()
		expect((self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(5)
	})

	it('cancelUpdateData drops a pending rebuild', () => {
		const self = createMockInstance()
		scheduleUpdateData(self)
		cancelUpdateData(self)
		vi.advanceTimersByTime(10000)
		expect(self.setActionDefinitions).not.toHaveBeenCalled()
	})

	it('flushUpdateData runs a pending rebuild immediately', () => {
		const self = createMockInstance()
		scheduleUpdateData(self)
		flushUpdateData(self)
		expect(self.setActionDefinitions).toHaveBeenCalledTimes(1)
	})

	it('keeps separate debounce state per instance', () => {
		const a = createMockInstance()
		const b = createMockInstance()
		scheduleUpdateData(a)
		cancelUpdateData(a)
		scheduleUpdateData(b)
		vi.advanceTimersByTime(500)
		expect(a.setActionDefinitions).not.toHaveBeenCalled()
		expect(b.setActionDefinitions).toHaveBeenCalledTimes(1)
	})
})

describe('scheduleCheckVariables', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function twoDevices() {
		return createMockInstance({
			devicesData: {
				'10.0.0.5': { name: 'DeviceA', ports: {}, rx: { count: 1, 1: { number: 1, name: 'In 1' } } },
				'10.0.0.6': { name: 'DeviceB', ports: {}, rx: { count: 1, 1: { number: 1, name: 'In 1' } } },
			},
		})
	}

	function pushes(self: DanteInstance) {
		return (self.setVariableValues as ReturnType<typeof vi.fn>).mock.calls
	}

	it('pushes immediately on the leading edge', () => {
		const self = twoDevices()
		scheduleCheckVariables(self, '10.0.0.5', 'rx')
		expect(pushes(self)).toHaveLength(1)
	})

	it('collapses a burst within the window into the leading push plus one trailing push', () => {
		const self = twoDevices()
		for (let i = 0; i < 20; i++) scheduleCheckVariables(self, '10.0.0.5', 'rx')
		expect(pushes(self)).toHaveLength(1) // leading only so far
		vi.advanceTimersByTime(30)
		expect(pushes(self)).toHaveLength(2) // trailing edge fires once
	})

	it('does not lose devices queued behind the leading edge', () => {
		const self = twoDevices()
		scheduleCheckVariables(self, '10.0.0.5', 'ip') // consumes the leading edge
		scheduleCheckVariables(self, '10.0.0.5', 'rx_names')
		scheduleCheckVariables(self, '10.0.0.6', 'rx_names')
		vi.advanceTimersByTime(30)

		// a last-args throttle would keep only DeviceB here and silently drop DeviceA's update
		expect(pushes(self)).toHaveLength(2)
		const last = pushes(self)[1][0]
		expect(last).toHaveProperty('DeviceA_rx_names')
		expect(last).toHaveProperty('DeviceB_rx_names')
	})

	it('unions requested types queued behind the leading edge into one push', () => {
		const self = twoDevices()
		scheduleCheckVariables(self, '10.0.0.5', 'ip') // consumes the leading edge
		scheduleCheckVariables(self, '10.0.0.5', 'rx')
		scheduleCheckVariables(self, '10.0.0.5', 'rx_names')
		vi.advanceTimersByTime(30)

		// the two queued requests coalesce into a single trailing push carrying both types
		expect(pushes(self)).toHaveLength(2)
		const last = pushes(self)[1][0]
		expect(last).toHaveProperty('DeviceA_rx')
		expect(last).toHaveProperty('DeviceA_rx_names')
	})

	it('an unscoped request widens the window to every device', () => {
		const self = twoDevices()
		scheduleCheckVariables(self, '10.0.0.5', 'rx')
		scheduleCheckVariables(self) // all devices, all types
		vi.advanceTimersByTime(30)

		const last = pushes(self)[pushes(self).length - 1][0]
		expect(last).toHaveProperty('DeviceA_ip')
		expect(last).toHaveProperty('DeviceB_ip')
	})

	it('refreshes pullup on a default sweep', () => {
		const self = twoDevices()
		self.devicesData['10.0.0.5'].pullup = '0%'
		scheduleCheckVariables(self)

		const last = pushes(self)[pushes(self).length - 1][0]
		expect(last).toHaveProperty('DeviceA_pullup', '0%')
	})

	it('cancelCheckVariables drops a pending trailing push', () => {
		const self = twoDevices()
		scheduleCheckVariables(self, '10.0.0.5', 'rx') // leading
		scheduleCheckVariables(self, '10.0.0.6', 'rx') // queued for trailing
		const before = pushes(self).length

		cancelCheckVariables(self)
		vi.advanceTimersByTime(1000)
		expect(pushes(self)).toHaveLength(before)
	})

	it('keeps separate throttle state per instance', () => {
		const a = twoDevices()
		const b = twoDevices()
		scheduleCheckVariables(a, '10.0.0.5', 'rx')
		scheduleCheckVariables(b, '10.0.0.5', 'rx')
		expect(pushes(a)).toHaveLength(1)
		expect(pushes(b)).toHaveLength(1)
	})
})

describe('scheduleCheckFeedbacks', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function byId(self: DanteInstance) {
		return (self.checkFeedbacksById as ReturnType<typeof vi.fn>).mock.calls
	}

	function byType(self: DanteInstance) {
		return (self.checkAllFeedbacks as ReturnType<typeof vi.fn>).mock.calls
	}

	it('checks only the feedbacks that read the changed device', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5', '10.0.0.6'])
		trackFeedbackDevices(self, 'fb-b', ['10.0.0.7', '10.0.0.8'])

		scheduleCheckFeedbacks(self, '10.0.0.5')
		expect(byId(self)[0]).toEqual(['fb-a'])
	})

	it('matches on the source device too, not just the destination', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5', '10.0.0.6'])

		// a tx-channel rename on the *source* device must still re-check the feedback
		scheduleCheckFeedbacks(self, '10.0.0.6')
		expect(byId(self)[0]).toEqual(['fb-a'])
	})

	it('always includes wildcard feedbacks whose devices did not resolve', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5', '10.0.0.6'])
		trackFeedbackDevices(self, 'fb-wild', ['10.0.0.9', undefined])

		scheduleCheckFeedbacks(self, '10.0.0.5')
		expect(byId(self)[0]).toContain('fb-wild')
		expect(byId(self)[0]).toContain('fb-a')
	})

	it('does not repeat a wildcard feedback that also matches on a resolved device', () => {
		const self = createMockInstance()
		// resolved on one end, unresolved on the other: present in both the wildcard set and the map
		trackFeedbackDevices(self, 'fb-wild', ['10.0.0.9', undefined])

		scheduleCheckFeedbacks(self, '10.0.0.9')
		expect(byId(self)[0]).toEqual(['fb-wild'])
	})

	it('issues no check when no tracked feedback reads the changed device', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5', '10.0.0.6'])

		scheduleCheckFeedbacks(self, '10.0.0.99')
		vi.advanceTimersByTime(30)
		expect(byId(self)).toHaveLength(0)
		expect(byType(self)).toHaveLength(0)
	})

	it('falls back to a type-level check for an unattributable change', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5', '10.0.0.6'])

		scheduleCheckFeedbacks(self)
		expect(byType(self)).toHaveLength(1)
		expect(byId(self)).toHaveLength(0)
	})

	it('falls back to a type-level check when nothing has been tracked yet', () => {
		const self = createMockInstance()
		scheduleCheckFeedbacks(self, '10.0.0.5')
		expect(byType(self)).toHaveLength(1)
	})

	it('unions devices queued behind the leading edge into one targeted check', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5'])
		trackFeedbackDevices(self, 'fb-b', ['10.0.0.6'])
		trackFeedbackDevices(self, 'fb-c', ['10.0.0.7'])

		scheduleCheckFeedbacks(self, '10.0.0.7') // consumes the leading edge
		scheduleCheckFeedbacks(self, '10.0.0.5')
		scheduleCheckFeedbacks(self, '10.0.0.6')
		vi.advanceTimersByTime(30)

		expect(byId(self)).toHaveLength(2)
		expect(byId(self)[1].sort()).toEqual(['fb-a', 'fb-b'])
	})

	it('re-tracking a feedback replaces its previous devices', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5'])
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.6']) // user repointed the dropdown

		scheduleCheckFeedbacks(self, '10.0.0.5')
		vi.advanceTimersByTime(30)
		expect(byId(self)).toHaveLength(0)
	})

	it('re-tracking with resolved devices clears an earlier wildcard registration', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5', undefined])
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5', '10.0.0.6']) // the device was discovered
		trackFeedbackDevices(self, 'fb-b', ['10.0.0.9'])

		scheduleCheckFeedbacks(self, '10.0.0.9')
		expect(byId(self)[0]).toEqual(['fb-b'])
	})

	it('untrackFeedback stops a removed feedback being checked', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5'])
		untrackFeedback(self, 'fb-a')

		scheduleCheckFeedbacks(self, '10.0.0.5')
		vi.advanceTimersByTime(30)
		expect(byId(self)).toHaveLength(0)
	})

	it('cancelCheckFeedbacks drops a pending trailing check', () => {
		const self = createMockInstance()
		trackFeedbackDevices(self, 'fb-a', ['10.0.0.5'])
		trackFeedbackDevices(self, 'fb-b', ['10.0.0.6'])

		scheduleCheckFeedbacks(self, '10.0.0.5') // leading
		scheduleCheckFeedbacks(self, '10.0.0.6') // queued
		const before = byId(self).length

		cancelCheckFeedbacks(self)
		vi.advanceTimersByTime(1000)
		expect(byId(self)).toHaveLength(before)
	})
})

describe('firstChoiceId / currentChoiceId', () => {
	// Sample rates as the module stores them: choice ids are strings, device.sr is a number.
	const rates = [
		{ id: '44100', label: '44.1 kHz' },
		{ id: '48000', label: '48 kHz' },
		{ id: '96000', label: '96 kHz' },
	]
	// Encodings: the device's current value is the decoded label, the choice id is the code.
	const encodings = [
		{ id: '16', label: 'PCM16' },
		{ id: '24', label: 'PCM24' },
		{ id: '32', label: 'PCM32' },
	]

	it('firstChoiceId takes the first entry of the list actually offered', () => {
		expect(firstChoiceId(rates, 0)).toBe('44100')
	})

	it('firstChoiceId falls back when there is nothing to offer', () => {
		expect(firstChoiceId([], 0)).toBe(0)
		expect(firstChoiceId([], '')).toBe('')
	})

	it('currentChoiceId matches a numeric current value against string ids', () => {
		// TAV-MINEOLA22XLR runs at 48k while supporting 44.1/48/88.2/96
		expect(currentChoiceId(rates, 48000, 0)).toBe('48000')
	})

	it('currentChoiceId matches a decoded label against its code', () => {
		// device.encoding is stored as 'PCM24', the choice id is '24'
		expect(currentChoiceId(encodings, 'PCM24', 0)).toBe('24')
	})

	it('currentChoiceId falls back to the first choice when the current value is unknown', () => {
		expect(currentChoiceId(rates, 192000, 0)).toBe('44100')
		expect(currentChoiceId(rates, undefined, 0)).toBe('44100')
	})

	it('currentChoiceId falls back to the fallback when there are no choices', () => {
		expect(currentChoiceId([], 48000, 0)).toBe(0)
	})

	it('prefers an id match over a label match', () => {
		const ambiguous = [
			{ id: 'a', label: 'b' },
			{ id: 'b', label: 'c' },
		]
		expect(currentChoiceId(ambiguous, 'b', '')).toBe('b')
	})
})

describe('channel query paging', () => {
	function withCounts(rx: number, tx: number) {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { '10.0.0.5': { name: 'Dev', ports: { ARC: 4440 }, rx: { count: rx }, tx: { count: tx } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
			counter: Buffer.from('0001', 'hex'),
		})
		return { self, send }
	}

	/**
	 * The starting channel a query asks for.
	 *
	 * makeCommand lays out protocol(2) length(2) counter(2) opcode(2) requestFlag(2) then the
	 * arguments, so argument bytes 2-3 - which hold the channel as a big-endian u16 - are at packet
	 * offset 12.
	 */
	const startingChannel = (packet: Buffer) => packet.readUInt16BE(12)

	it('pages the receive query by the receive count', () => {
		const { self, send } = withCounts(32, 8)
		getRxChannels(self, '10.0.0.5')
		expect(send.mock.calls.map(([packet]) => startingChannel(packet as Buffer))).toEqual([1, 17])
	})

	it('pages the transmit query by 32', () => {
		const { self, send } = withCounts(8, 64)
		getTxChannels(self, '10.0.0.5')
		expect(send.mock.calls.map(([packet]) => startingChannel(packet as Buffer))).toEqual([1, 33])
	})

	it('sends one probe when the channel count is not yet known', () => {
		const { self, send } = withCounts(0, 0)
		getRxChannels(self, '10.0.0.5')
		expect(send).toHaveBeenCalledTimes(1)
		expect(startingChannel(send.mock.calls[0][0] as Buffer)).toBe(1)
	})

	it('emits the exact bytes the devices are known to accept', () => {
		const { self, send } = withCounts(4, 0)
		getRxChannels(self, '10.0.0.5')
		expect((send.mock.calls[0][0] as Buffer).toString('hex')).toBe('27290010000130000000000100010000')
	})

	it('pages past channel 255 rather than throwing', () => {
		const { self, send } = withCounts(512, 0)
		expect(() => getRxChannels(self, '10.0.0.5')).not.toThrow()

		const starts = send.mock.calls.map(([packet]) => startingChannel(packet as Buffer))
		expect(starts).toHaveLength(32)
		expect(starts[0]).toBe(1)
		expect(starts[16]).toBe(257) // the page a single-byte write could not express
		expect(starts[31]).toBe(497)
	})

	it('covers every channel of a 512-channel device exactly once', () => {
		const { self, send } = withCounts(512, 0)
		getRxChannels(self, '10.0.0.5')
		const starts = send.mock.calls.map(([packet]) => startingChannel(packet as Buffer))
		expect(starts).toEqual(Array.from({ length: 32 }, (_, i) => i * 16 + 1))
	})
})

describe('macForDevice', () => {
	const CHOSEN = Buffer.from('aaaaaaaaaaaa', 'hex')

	it('uses the card recorded for that device', () => {
		const self = createMockInstance({
			mac: CHOSEN,
			devicesData: { '10.0.0.5': { name: 'A', interfaceMac: 'bbbbbbbbbbbb' } },
		})
		expect(macForDevice(self, '10.0.0.5').toString('hex')).toBe('bbbbbbbbbbbb')
	})

	it('falls back to the instance card when the device has none recorded', () => {
		const self = createMockInstance({ mac: CHOSEN, devicesData: { '10.0.0.5': { name: 'A' } } })
		expect(macForDevice(self, '10.0.0.5')).toBe(CHOSEN)
	})

	it('falls back for a device that is not registered', () => {
		const self = createMockInstance({ mac: CHOSEN, devicesData: {} })
		expect(macForDevice(self, '10.0.0.9')).toBe(CHOSEN)
	})

	it('gives each device its own card when they are on different networks', () => {
		// the case a single instance-wide address could not express: two Dante networks, where one
		// address is wrong for whichever device did not happen to answer mDNS first
		const self = createMockInstance({
			mac: Buffer.alloc(6),
			devicesData: {
				'10.0.0.5': { name: 'A', interfaceMac: 'aaaaaaaaaaaa' },
				'192.168.7.9': { name: 'B', interfaceMac: 'cccccccccccc' },
			},
		})
		expect(macForDevice(self, '10.0.0.5').toString('hex')).toBe('aaaaaaaaaaaa')
		expect(macForDevice(self, '192.168.7.9').toString('hex')).toBe('cccccccccccc')
	})

	it('embeds the per-device card in the settings command itself', () => {
		const self = createMockInstance({
			mac: Buffer.alloc(6),
			counter: Buffer.from('0001', 'hex'),
			devicesData: {
				'10.0.0.5': { name: 'A', interfaceMac: 'aaaaaaaaaaaa' },
				'192.168.7.9': { name: 'B', interfaceMac: 'cccccccccccc' },
			},
		})
		const a = makeSettingCommand(self, 0x0081, Buffer.alloc(4), '10.0.0.5')
		const b = makeSettingCommand(self, 0x0081, Buffer.alloc(4), '192.168.7.9')

		// the hardware address sits at offset 8, after protocol, length, counter and the start block
		expect(a.subarray(8, 14).toString('hex')).toBe('aaaaaaaaaaaa')
		expect(b.subarray(8, 14).toString('hex')).toBe('cccccccccccc')
	})

	it('uses the instance card when no device is named', () => {
		const self = createMockInstance({ mac: CHOSEN, counter: Buffer.from('0001', 'hex'), devicesData: {} })
		expect(makeSettingCommand(self, 0x0081, Buffer.alloc(4)).subarray(8, 14)).toEqual(CHOSEN)
	})
})

describe('resolveDeviceIp / deviceByIdentifier', () => {
	function twoDevices() {
		return createMockInstance({
			devicesData: {
				'10.0.0.5': { name: 'DeviceA', ports: { ARC: 4440 } },
				'10.0.0.6': { name: 'DeviceB', ports: { ARC: 4440 } },
			},
		})
	}

	it('resolves a device name, which is what dropdowns now store', () => {
		expect(resolveDeviceIp(twoDevices(), 'DeviceB')).toBe('10.0.0.6')
	})

	it('resolves an address, which is what actions saved earlier store', () => {
		expect(resolveDeviceIp(twoDevices(), '10.0.0.5')).toBe('10.0.0.5')
	})

	it('returns undefined for an unknown device and for an empty identifier', () => {
		expect(resolveDeviceIp(twoDevices(), 'Nope')).toBeUndefined()
		expect(resolveDeviceIp(twoDevices(), '')).toBeUndefined()
	})

	it('follows a device to its new address after renumbering', () => {
		// the point of keying by name: link-local and DHCP reassign addresses, names persist
		const renumbered = createMockInstance({
			devicesData: { '169.254.99.1': { name: 'DeviceA', ports: { ARC: 4440 } } },
		})
		expect(resolveDeviceIp(renumbered, 'DeviceA')).toBe('169.254.99.1')
	})

	it('deviceByIdentifier returns the same record either way', () => {
		const self = twoDevices()
		expect(deviceByIdentifier(self, 'DeviceA')).toBe(self.devicesData['10.0.0.5'])
		expect(deviceByIdentifier(self, '10.0.0.5')).toBe(self.devicesData['10.0.0.5'])
		expect(deviceByIdentifier(self, 'Nope')).toBeUndefined()
	})

	it('sendCommand accepts a name as well as an address', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { '10.0.0.5': { name: 'DeviceA', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		const buf = Buffer.from('aabb', 'hex')

		sendCommand(self, buf, 'DeviceA')
		expect(send).toHaveBeenCalledWith(buf, 0, buf.length, 4440, '10.0.0.5')

		send.mockClear()
		sendCommand(self, buf, '10.0.0.5')
		expect(send).toHaveBeenCalledWith(buf, 0, buf.length, 4440, '10.0.0.5')
	})
})

describe('updateChannelChoices', () => {
	function withChannels(channelType: 'rx' | 'tx', count: number) {
		const io: Record<string | number, unknown> = { count }
		for (let i = 1; i <= count; i++) io[i] = { number: i, name: `Ch ${i}` }
		return createMockInstance({
			devicesData: { '10.0.0.5': { name: 'Dev', ports: {}, [channelType]: io } },
		})
	}

	it('offers one entry per channel, numbered from 1', () => {
		const self = withChannels('rx', 3)
		updateChannelChoices(self, '10.0.0.5', 'rx')
		expect(self.rxChannelsChoices.Dev).toEqual([
			{ id: 1, label: 'Ch 1' },
			{ id: 2, label: 'Ch 2' },
			{ id: 3, label: 'Ch 3' },
		])
	})

	it('offers no "None" entry, which would only mean "do nothing"', () => {
		const self = withChannels('rx', 2)
		updateChannelChoices(self, '10.0.0.5', 'rx')
		expect(self.rxChannelsChoices.Dev.map((choice) => choice.id)).not.toContain(0)
	})

	it('so the first choice is a real channel rather than a no-op default', () => {
		const self = withChannels('tx', 2)
		updateChannelChoices(self, '10.0.0.5', 'tx')
		expect(self.txChannelsChoices.Dev[0].id).toBe(1)
	})

	it('builds tx choices without leaving a gap where "None" used to sit', () => {
		// the tx branch assigned by index, which relied on the None entry occupying index 0
		const self = withChannels('tx', 3)
		updateChannelChoices(self, '10.0.0.5', 'tx')
		expect(self.txChannelsChoices.Dev).toHaveLength(3)
		expect(self.txChannelsChoices.Dev.every((choice) => choice !== undefined)).toBe(true)
	})

	it('rebuilds when a channel is renamed', () => {
		const self = withChannels('rx', 2)
		updateChannelChoices(self, '10.0.0.5', 'rx')
		;(self.devicesData['10.0.0.5'].rx as Record<number, { name: string }>)[2].name = 'Renamed'
		updateChannelChoices(self, '10.0.0.5', 'rx')
		expect(self.rxChannelsChoices.Dev[1].label).toBe('Renamed')
	})

	it('rebuilds when the channel count shrinks', () => {
		const self = withChannels('rx', 3)
		updateChannelChoices(self, '10.0.0.5', 'rx')
		const io = self.devicesData['10.0.0.5'].rx as { count: number }
		io.count = 1
		updateChannelChoices(self, '10.0.0.5', 'rx')
		expect(self.rxChannelsChoices.Dev).toHaveLength(1)
	})

	it('produces an empty list for a device with no channels', () => {
		const self = withChannels('rx', 0)
		updateChannelChoices(self, '10.0.0.5', 'rx')
		expect(self.rxChannelsChoices.Dev).toEqual([])
	})
})

describe('sendCommand', () => {
	it('sends via the port learned for the given service', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { '10.0.0.5': { ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		const buf = Buffer.from('aabb', 'hex')
		sendCommand(self, buf, '10.0.0.5')
		expect(send).toHaveBeenCalledWith(buf, 0, buf.length, 4440, '10.0.0.5')
	})

	it('uses forcePort when given, overriding the learned port', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { '10.0.0.5': { ports: { CMC: 8800 } } },
			sockets: { CMC: { send } as unknown as dgram.Socket },
		})
		const buf = Buffer.from('aabb', 'hex')
		sendCommand(self, buf, '10.0.0.5', 'CMC', 9999)
		expect(send).toHaveBeenCalledWith(buf, 0, buf.length, 9999, '10.0.0.5')
	})

	it('logs an error and sends nothing when no port is known', () => {
		const send = vi.fn()
		const self = createMockInstance({ sockets: { ARC: { send } as unknown as dgram.Socket } })
		sendCommand(self, Buffer.from('aa', 'hex'), '10.0.0.5')
		expect(send).not.toHaveBeenCalled()
		expect(loggerSink).toHaveBeenCalledWith('api', 'error', expect.stringContaining('Undefined port'))
	})
})

describe('makeCommand', () => {
	it('builds an ARC command with the CONTROL protocol marker and increments the counter', () => {
		const self = createMockInstance({ counter: Buffer.from('0000', 'hex') })
		const buf = makeCommand(self, 0x1002)
		expect(buf.readUInt16BE(0)).toBe(DANTE_CONST.PROTOCOL.CONTROL)
		expect(buf.readUInt16BE(2)).toBe(buf.length) // length field matches the actual payload size
		expect(buf.readUInt16BE(6)).toBe(0x1002) // commandType
		expect(self.counter).toEqual(Buffer.from('0001', 'hex'))
	})

	it('includes the given command arguments in the payload', () => {
		const self = createMockInstance()
		const args = Buffer.from('deadbeef', 'hex')
		const buf = makeCommand(self, 0x1002, args)
		expect(buf.subarray(10, 14)).toEqual(args)
	})
})

describe('makeSettingCommand', () => {
	it('builds a SETTINGS command embedding the protocol marker, mac address, and commandType', () => {
		const mac = Buffer.from('aabbccddeeff', 'hex')
		const self = createMockInstance({ counter: Buffer.from('0000', 'hex'), mac })
		const buf = makeSettingCommand(self, 0x0081)
		expect(buf.readUInt16BE(0)).toBe(DANTE_CONST.PROTOCOL.SETTINGS)
		expect(buf.subarray(8, 14)).toEqual(mac)
		expect(buf.readUInt16BE(26)).toBe(0x0081)
		expect(self.counter).toEqual(Buffer.from('0001', 'hex'))
	})
})

describe('setChannelName', () => {
	it("throws for a channel type that isn't 'rx' or 'tx'", () => {
		const self = createMockInstance()
		expect(() => setChannelName(self, '10.0.0.5', 'name', 'bogus' as 'rx', 1)).toThrow(
			"Invalid Channel Type - must be 'tx' or 'rx'",
		)
	})

	it('sends a command for a valid rx channel rename', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { '10.0.0.5': { ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		setChannelName(self, '10.0.0.5', 'NewName', 'rx', 3)
		expect(send).toHaveBeenCalled()
	})
})

describe('makeCrosspoint / clearCrosspoint', () => {
	it('makeCrosspoint logs an error and sends nothing when the destination device cannot be resolved', () => {
		const send = vi.fn()
		const self = createMockInstance({ sockets: { ARC: { send } as unknown as dgram.Socket } })
		makeCrosspoint(self, 'UnknownDevice', 'Input 1', 'SourceDevice', '1')
		expect(send).not.toHaveBeenCalled()
		expect(loggerSink).toHaveBeenCalledWith('api', 'error', expect.stringContaining("Can't find"))
	})

	it('makeCrosspoint resolves an IP-address destination directly, without a name lookup', () => {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { '10.0.0.5': { name: 'Dest', ports: { ARC: 4440 } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
		})
		makeCrosspoint(self, '10.0.0.5', 'Input 1', 'SourceDevice', '1')
		expect(send).toHaveBeenCalledWith(expect.any(Buffer), 0, expect.any(Number), 4440, '10.0.0.5')
	})

	it('clearCrosspoint logs an error when the destination device cannot be resolved', () => {
		const self = createMockInstance()
		clearCrosspoint(self, 'UnknownDevice', '1')
		expect(loggerSink).toHaveBeenCalledWith('api', 'error', expect.stringContaining("Can't find"))
	})
})

describe('clearAllCrosspoints', () => {
	function withRx(count: number) {
		const send = vi.fn()
		const self = createMockInstance({
			devicesData: { '10.0.0.5': { name: 'Dev', ports: { ARC: 4440 }, rx: { count } } },
			sockets: { ARC: { send } as unknown as dgram.Socket },
			counter: Buffer.from('4242', 'hex'),
		})
		return { self, send }
	}

	it('clears a whole device in a single packet', () => {
		const { self, send } = withRx(8)
		clearAllCrosspoints(self, '10.0.0.5')
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('emits the byte layout the device accepts', () => {
		const { self, send } = withRx(2)
		clearAllCrosspoints(self, '10.0.0.5')

		// protocol, length, counter, opcode 0x3014, then [count u32][channel u32...] and a trailing 0.
		// The count's high half comes from makeCommand's two zero request-flag bytes.
		expect((send.mock.calls[0][0] as Buffer).toString('hex')).toBe('272900154242301400000002000000010000000200')
	})

	it('splits a high channel count across packets rather than one huge datagram', () => {
		const { self, send } = withRx(40)
		clearAllCrosspoints(self, '10.0.0.5')
		expect(send).toHaveBeenCalledTimes(3) // 16 + 16 + 8

		const channelsIn = (call: number) => {
			const packet = send.mock.calls[call][0] as Buffer
			// count is a u32 spanning offsets 8-11; its low half sits at 10
			return packet.readUInt16BE(10)
		}
		expect([channelsIn(0), channelsIn(1), channelsIn(2)]).toEqual([16, 16, 8])
	})

	it('covers every channel exactly once across the batches', () => {
		const { self, send } = withRx(40)
		clearAllCrosspoints(self, '10.0.0.5')

		const seen: number[] = []
		for (const [packet] of send.mock.calls as [Buffer][]) {
			const count = packet.readUInt16BE(10)
			for (let i = 0; i < count; i++) seen.push(packet.readUInt32BE(12 + 4 * i))
		}
		expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
	})

	it('sends nothing when the device has no known receive channels', () => {
		const { self, send } = withRx(0)
		clearAllCrosspoints(self, '10.0.0.5')
		expect(send).not.toHaveBeenCalled()
	})

	it('resolves a device name as well as an IP', () => {
		const { self, send } = withRx(4)
		clearAllCrosspoints(self, 'Dev')
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('logs an error for an unknown device', () => {
		const { self, send } = withRx(4)
		clearAllCrosspoints(self, 'NoSuchDevice')
		expect(send).not.toHaveBeenCalled()
		expect(loggerSink).toHaveBeenCalledWith('api', 'error', expect.stringContaining('NoSuchDevice'))
	})
})

describe('parseHeartbeatReply', () => {
	it('marks the connection Ok on a valid packet (real capture)', () => {
		const self = createMockInstance({ CONNECTED: false })
		const reply = Buffer.from(REAL_HEARTBEAT_HEX, 'hex')
		parseHeartbeatReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))
		expect(self.CONNECTED).toBe(true)
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.Ok)
	})

	it('ignores a packet with the wrong protocol marker', () => {
		const self = createMockInstance({ CONNECTED: false })
		const reply = Buffer.alloc(84)
		parseHeartbeatReply(self, reply, makeRinfo(REAL_DEVICE_IP, 84))
		expect(self.CONNECTED).toBe(false)
		expect(self.updateStatus).not.toHaveBeenCalled()
	})
})

describe('parseCmcReply', () => {
	it('learns the SETTINGS port for an already-registered device (real capture)', () => {
		const self = createMockInstance({
			devicesData: { [REAL_DEVICE_IP]: { name: 'NAM-262de4', ports: {} } },
		})
		const reply = Buffer.from(REAL_CMC_HEX, 'hex')
		parseCmcReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))
		expect(self.devicesData[REAL_DEVICE_IP]?.ports?.SETTINGS).toBe(8700)
	})

	it('ignores CMC traffic from a device not yet registered via mDNS discovery', () => {
		const self = createMockInstance({ devicesData: {} })
		const reply = Buffer.from(REAL_CMC_HEX, 'hex')
		parseCmcReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))
		expect(self.devicesData[REAL_DEVICE_IP]).toBeUndefined()
	})
})

describe('parseReply (ARC)', () => {
	it('ignores ARC traffic from a device not yet registered via mDNS discovery', () => {
		const self = createMockInstance({ devicesData: {} })
		const reply = Buffer.from(REAL_ARC_HEX, 'hex')
		expect(() => parseReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))).not.toThrow()
		expect(self.devicesData[REAL_DEVICE_IP]).toBeUndefined()
	})

	it('processes ARC traffic for an already-registered device without throwing (real capture)', () => {
		const self = createMockInstance({ devicesData: { [REAL_DEVICE_IP]: { name: 'NAM-262de4' } } })
		const reply = Buffer.from(REAL_ARC_HEX, 'hex')
		expect(() => parseReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))).not.toThrow()
	})
})

describe('parseReply (ARC) - malformed packet handling', () => {
	const IP = '10.0.0.5'

	/**
	 * Builds an ARC channel-query reply: 0x2729 header, declared length, then a body claiming
	 * `recCount` records while actually carrying `records`.
	 */
	function arcReply(opcode: number, recCount: number, records: Buffer): Buffer {
		const head = Buffer.alloc(12)
		head.writeUInt16BE(0x2729, 0) // protocol
		head.writeUInt16BE(12 + records.length, 2) // length, must equal rinfo.size
		head.writeUInt16BE(0, 4) // counter
		head.writeUInt16BE(opcode, 6)
		head.writeUInt8(recCount, 11)
		return Buffer.concat([head, records])
	}

	function registered() {
		return createMockInstance({ devicesData: { [IP]: { name: 'Dev', ports: { ARC: 4440 } } } })
	}

	it('survives an rx reply claiming more records than the packet contains', () => {
		// one 20-byte record present, but the count byte claims 16
		const reply = arcReply(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY, 16, Buffer.alloc(20))
		const self = registered()
		expect(() => parseReply(self, reply, makeRinfo(IP, reply.length))).not.toThrow()
	})

	it('survives an rx reply truncated mid-record', () => {
		const reply = arcReply(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY, 8, Buffer.alloc(30))
		const self = registered()
		expect(() => parseReply(self, reply, makeRinfo(IP, reply.length))).not.toThrow()
	})

	it('survives a tx reply whose sample-rate pointer runs past the end of the packet', () => {
		// record 0: channel 1, group pointer 0xFFF0 (far outside the buffer), name pointer 0
		const record = Buffer.alloc(8)
		record.writeUInt16BE(1, 0)
		record.writeUInt16BE(0xfff0, 4)
		const reply = arcReply(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY, 1, record)
		const self = registered()
		expect(() => parseReply(self, reply, makeRinfo(IP, reply.length))).not.toThrow()
		expect(self.devicesData[IP]?.tx?.[1]?.sampleRate).toBeUndefined()
	})

	it('survives a tx reply whose sample-rate pointer lands within 4 bytes of the end', () => {
		const record = Buffer.alloc(8)
		record.writeUInt16BE(1, 0)
		const reply = arcReply(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY, 1, record)
		// point at the last two bytes, so a 4-byte read would overrun
		record.writeUInt16BE(reply.length - 2, 4)
		const reply2 = arcReply(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY, 1, record)
		const self = registered()
		expect(() => parseReply(self, reply2, makeRinfo(IP, reply2.length))).not.toThrow()
	})

	it('survives a friendly-names reply claiming more records than it carries', () => {
		const reply = arcReply(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY, 32, Buffer.alloc(6))
		const self = registered()
		expect(() => parseReply(self, reply, makeRinfo(IP, reply.length))).not.toThrow()
	})

	it('still parses a well-formed rx record', () => {
		const record = Buffer.alloc(20)
		record.writeUInt16BE(1, 0) // channel number
		record.writeUInt16BE(10, 14) // subscription status
		const reply = arcReply(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY, 1, record)
		const self = registered()
		parseReply(self, reply, makeRinfo(IP, reply.length))
		expect(self.devicesData[IP]?.rx?.[1]?.subscriptionStatus).toBe(10)
	})
})

describe('parseReply (ARC) - channel count', () => {
	const IP = '10.0.0.5'

	/** A real 56-byte channel-count reply captured from NAM-262de4 (8 tx, 8 rx, unlocked). */
	const REAL_COUNT_HEX =
		'272900380001100000010ff90008000800000040004000200020000800010002000000000000000000000000000000000000000100000001'

	function registered() {
		return createMockInstance({ devicesData: { [IP]: { name: 'Dev', ports: { ARC: 4440 } } } })
	}

	it('reads tx and rx counts from a real reply', () => {
		const self = registered()
		const reply = Buffer.from(REAL_COUNT_HEX, 'hex')
		parseReply(self, reply, makeRinfo(IP, reply.length))
		expect(self.devicesData[IP]?.tx?.count).toBe(8)
		expect(self.devicesData[IP]?.rx?.count).toBe(8)
	})

	it('reports an unlocked device as unlocked', () => {
		const self = registered()
		const reply = Buffer.from(REAL_COUNT_HEX, 'hex')
		parseReply(self, reply, makeRinfo(IP, reply.length))
		expect(self.devicesData[IP]?.locked).toBe(false)
	})

	it('reports a locked device as locked', () => {
		const self = registered()
		const reply = Buffer.from(REAL_COUNT_HEX, 'hex')
		reply.writeUInt16BE(1, 34) // flip the lock flag
		parseReply(self, reply, makeRinfo(IP, reply.length))
		expect(self.devicesData[IP]?.locked).toBe(true)
	})

	it('leaves lock state undefined on a reply too short to carry the field', () => {
		const self = registered()
		const short = Buffer.from(REAL_COUNT_HEX, 'hex').subarray(0, 30)
		short.writeUInt16BE(30, 2) // keep the declared length consistent with rinfo.size
		expect(() => parseReply(self, short, makeRinfo(IP, short.length))).not.toThrow()
		expect(self.devicesData[IP]?.locked).toBeUndefined()
	})
})

describe('parseSettingsReply', () => {
	it('marks the connection Ok on a valid packet regardless of registration (real capture)', () => {
		const self = createMockInstance({ CONNECTED: false, devicesData: {} })
		const reply = Buffer.from(REAL_SETTINGS_HEX, 'hex')
		parseSettingsReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))
		expect(self.CONNECTED).toBe(true)
	})

	it('ignores SETTINGS traffic from a device not yet registered via mDNS discovery', () => {
		const self = createMockInstance({ devicesData: {} })
		const reply = Buffer.from(REAL_SETTINGS_HEX, 'hex')
		parseSettingsReply(self, reply, makeRinfo(REAL_DEVICE_IP, reply.length))
		expect(self.devicesData[REAL_DEVICE_IP]).toBeUndefined()
	})
})
