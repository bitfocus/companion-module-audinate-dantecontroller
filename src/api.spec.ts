import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { InstanceStatus, type LoggingSink } from '@companion-module/base'
import type dgram from 'node:dgram'
import {
	intToBuffer,
	bufferToInt,
	incrementBE,
	parseString,
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
	cancelUpdateData,
	flushUpdateData,
	sendCommand,
	makeCommand,
	makeSettingCommand,
	setChannelName,
	makeCrosspoint,
	clearCrosspoint,
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
		CONNECTED: false,
		INTERVAL: null,
		mdns: { query: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn(), destroy: vi.fn() },
		config: { ip: '', interval: 1000, timeoutInterval: 3000, verbose: false },
		log: vi.fn(),
		updateStatus: vi.fn(),
		checkFeedbacks: vi.fn(),
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

describe('parseString', () => {
	it('decodes a NUL-terminated UTF-8 string', () => {
		const buf = Buffer.concat([Buffer.from('Hello', 'utf8'), Buffer.from([0x00]), Buffer.from('trailing')])
		expect(parseString(buf, 0)).toBe('Hello')
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
		expect(self.devicesChoices).toContainEqual({ id: '10.0.0.5', label: 'MyDevice' })
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
		expect(self.devicesChoices).toContainEqual({ id: '10.0.0.5', label: 'MyDevice' })
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
