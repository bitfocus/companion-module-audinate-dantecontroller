import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type dgram from 'node:dgram'
import type DanteInstance from '../../main.js'
import { parseSettingsReply } from '../protocol.js'

/**
 * What a socket error is allowed to do to the connection's state.
 *
 * `activeConnections` is set true only by a socket's 'listening' event, which fires once per socket
 * and never again - so anything marking a service false held it there for the life of the
 * connection, and the module reported Disconnected until someone restarted it by hand. A bound UDP
 * socket stays usable after an error, so an error alone must not do that.
 *
 * These drive the real `initConnection` against fake sockets, so they pin the handlers it actually
 * registers rather than a re-description of them.
 */

/** A dgram socket that records its listeners, so a test can fire them. */
function fakeSocket() {
	const handlers = new Map<string, (...args: never[]) => void>()
	return {
		handlers,
		on: vi.fn((event: string, handler: (...args: never[]) => void) => {
			handlers.set(event, handler)
		}),
		bind: vi.fn(),
		close: vi.fn(),
		send: vi.fn(),
		addMembership: vi.fn(),
		setMulticastInterface: vi.fn(),
		removeAllListeners: vi.fn(),
		address: () => ({ address: '0.0.0.0', family: 'IPv4', port: 1234 }),
	}
}

const sockets: ReturnType<typeof fakeSocket>[] = []
const mdnsHandlers = new Map<string, (...args: never[]) => void>()
let activeConnectionsReads = 0

vi.mock('node:dgram', () => ({
	default: {
		createSocket: () => {
			const socket = fakeSocket()
			sockets.push(socket)
			return socket as unknown as dgram.Socket
		},
	},
}))

vi.mock('multicast-dns', () => ({
	default: () => ({
		on: (event: string, handler: (...args: never[]) => void) => mdnsHandlers.set(event, handler),
		query: vi.fn(),
		destroy: vi.fn(),
		removeAllListeners: vi.fn(),
	}),
}))

const { DanteConnection, initConnection } = await import('../connection.js')

/** A stand-in instance wired to a real connection exactly as `DanteInstance` wires one. */
function instance(): DanteInstance {
	const self = {
		devicesData: {},
		devicesChoices: [],
		txChannelsChoices: {},
		rxChannelsChoices: {},
		videoTxChannelsChoices: {},
		videoRxChannelsChoices: {},
		txFriendlyNameRefreshCounter: 0,
		debug: false,
		timeout: 3000,
		// automatic card: one settings socket rather than two, and no address to resolve
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		log: vi.fn(),
		updateStatus: vi.fn(),
		saveConfig: vi.fn(),
	} as unknown as DanteInstance

	const connection = new DanteConnection(self)
	Object.defineProperties(self, {
		connection: { value: connection },
		sockets: { get: () => connection.sockets, set: (v) => (connection.sockets = v) },
		mdns: { get: () => connection.mdns, set: (v) => (connection.mdns = v) },
		counter: { get: () => connection.counter, set: (v) => (connection.counter = v) },
		mac: { get: () => connection.mac, set: (v) => (connection.mac = v) },
		activeConnections: {
			// `checkConnections` reads this once per service, so counting reads is how these tests see
			// whether it was entered at all
			get: () => {
				activeConnectionsReads++
				return connection.activeConnections
			},
			set: (v) => (connection.activeConnections = v),
		},
		configError: { get: () => connection.configError, set: (v) => (connection.configError = v) },
		CONNECTED: { get: () => connection.connected, set: (v) => (connection.connected = v) },
	})
	return self
}

/** Brings a connection up with every socket listening, as a healthy start does. */
function connected() {
	const self = instance()
	initConnection(self)

	for (const socket of sockets) socket.handlers.get('listening')?.()
	mdnsHandlers.get('ready')?.()

	return self
}

beforeEach(() => {
	sockets.length = 0
	mdnsHandlers.clear()
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('a socket error does not latch the service down', () => {
	it('brings every service up first, so the tests below start from a healthy connection', () => {
		const self = connected()
		expect(self.activeConnections).toEqual({
			ARC: true,
			SETTINGS: true,
			CMC: true,
			HEARTBEAT: true,
			MDNS: true,
		})
	})

	it.each(['ARC', 'SETTINGS', 'CMC', 'HEARTBEAT'])('leaves %s up when its socket errors', (service) => {
		const self = connected()
		const before = { ...self.activeConnections }

		for (const socket of sockets) socket.handlers.get('error')?.(new Error('EIO') as never)

		expect(self.activeConnections[service as 'ARC']).toBe(true)
		expect(self.activeConnections).toEqual(before)
	})

	it('still reports the error, so the fault is not silent', () => {
		connected()
		const logged: string[] = []
		global.COMPANION_LOGGER = vi.fn((_source, _level, message: string) => logged.push(message))

		sockets[0].handlers.get('error')?.(new Error('ENOBUFS') as never)
		global.COMPANION_LOGGER = undefined

		expect(logged.some((line) => line.includes('ENOBUFS'))).toBe(true)
	})

	it('still marks the service down when the socket actually closes', () => {
		// a close is a real death, and unlike an error it cannot reach a handler during teardown -
		// `DanteConnection.close` drops the listeners first
		const self = connected()
		sockets[0].handlers.get('close')?.()

		expect(self.activeConnections.ARC).toBe(false)
	})
})

describe('receiving on a socket clears a service marked down', () => {
	it('restores a service that a close had marked down', () => {
		const self = connected()
		sockets[0].handlers.get('close')?.()
		expect(self.activeConnections.ARC).toBe(false)

		self.connection.noteTraffic('ARC')
		expect(self.activeConnections.ARC).toBe(true)
	})

	it('reports Ok again once the last missing service comes back', () => {
		const self = connected()
		sockets[0].handlers.get('close')?.()
		expect(self.CONNECTED).toBe(false)
		;(self.updateStatus as ReturnType<typeof vi.fn>).mockClear()

		self.connection.noteTraffic('ARC')
		expect(self.CONNECTED).toBe(true)
		expect(self.updateStatus).toHaveBeenCalledTimes(1)
	})

	it('does not re-evaluate the status on every packet of a healthy connection', () => {
		// the flag is already true, so there is nothing to heal and no reason to walk every service
		// again - this runs per datagram, which on a busy network is constant
		const self = connected()
		;(self.updateStatus as ReturnType<typeof vi.fn>).mockClear()
		activeConnectionsReads = 0

		for (let i = 0; i < 100; i++) self.connection.noteTraffic('HEARTBEAT')
		expect(activeConnectionsReads).toBe(0)
		expect(self.updateStatus).not.toHaveBeenCalled()
	})

	it('does re-evaluate when a service is actually being restored', () => {
		// the guard above must not be so broad that it skips the case it exists to allow
		const self = connected()
		sockets[0].handlers.get('close')?.()
		activeConnectionsReads = 0

		self.connection.noteTraffic('ARC')
		expect(activeConnectionsReads).toBeGreaterThan(0)
	})
})

/**
 * The packet-handling backstop.
 *
 * The parsers guard their own header reads, but a reply carries dozens of fields at fixed offsets
 * deeper in - too many to bounds-check individually - and a truncated-but-self-consistent packet
 * still sends those reads out of bounds. Since these run from a socket 'message' event with no
 * process-level handler above them, an escaping throw kills the module. This contains it.
 */
describe('a malformed packet does not take the connection down', () => {
	/** The fake socket behind a named service, found by identity rather than creation order. */
	function socketFor(self: DanteInstance, service: 'ARC' | 'SETTINGS' | 'CMC' | 'HEARTBEAT') {
		const socket = self.sockets[service] as unknown as ReturnType<typeof fakeSocket>
		return sockets.find((candidate) => candidate === socket)!
	}

	/** A real settings reply clipped to a length its own size field agrees with. */
	function truncatedSettingsReply(length: number) {
		const full = Buffer.from(
			'ffff0034051f0000001dc1fffe2c87d6417564696e617465073d008000000000001800010000bb800000bb80000100000000bb80',
			'hex',
		)
		const clipped = Buffer.from(full.subarray(0, length))
		// self-consistent, so it gets past the size check and into the body - which is where the
		// unguarded reads are
		clipped.writeUInt16BE(length, 2)
		return clipped
	}

	function rinfoFor(reply: Buffer): dgram.RemoteInfo {
		return { address: '169.254.120.183', size: reply.length, port: 8702, family: 'IPv4' }
	}

	it('confirms such a packet really does throw, or this suite proves nothing', () => {
		// guards the tests below: if the parser stops throwing, they would pass without the backstop
		const reply = truncatedSettingsReply(30)
		const self = connected()
		self.devicesData['169.254.120.183'] = { name: 'DeviceA', ports: {} }

		expect(() => parseSettingsReply(self, reply, rinfoFor(reply))).toThrow()
	})

	it('contains the throw instead of letting it reach the socket handler', () => {
		const self = connected()
		self.devicesData['169.254.120.183'] = { name: 'DeviceA', ports: {} }
		const reply = truncatedSettingsReply(30)

		expect(() =>
			socketFor(self, 'SETTINGS').handlers.get('message')?.(reply as never, rinfoFor(reply) as never),
		).not.toThrow()
	})

	it('reports the discarded packet, naming where it came from', () => {
		const self = connected()
		self.devicesData['169.254.120.183'] = { name: 'DeviceA', ports: {} }
		const reply = truncatedSettingsReply(30)

		const logged: string[] = []
		global.COMPANION_LOGGER = vi.fn((_source, level: string, message: string) => {
			if (level === 'warn') logged.push(message)
		})
		socketFor(self, 'SETTINGS').handlers.get('message')?.(reply as never, rinfoFor(reply) as never)
		global.COMPANION_LOGGER = undefined

		expect(logged.some((line) => line.includes('169.254.120.183'))).toBe(true)
	})

	it('reports it once, so a device streaming junk cannot flood the log', () => {
		const self = connected()
		self.devicesData['169.254.120.183'] = { name: 'DeviceA', ports: {} }
		const reply = truncatedSettingsReply(30)

		const logged: string[] = []
		global.COMPANION_LOGGER = vi.fn((_source, level: string, message: string) => {
			if (level === 'warn') logged.push(message)
		})
		for (let i = 0; i < 50; i++) {
			socketFor(self, 'SETTINGS').handlers.get('message')?.(reply as never, rinfoFor(reply) as never)
		}
		global.COMPANION_LOGGER = undefined

		expect(logged).toHaveLength(1)
	})

	it('still counts the packet as traffic, since the socket is plainly working', () => {
		const self = connected()
		socketFor(self, 'SETTINGS').handlers.get('close')?.()
		expect(self.activeConnections.SETTINGS).toBe(false)

		const reply = truncatedSettingsReply(30)
		socketFor(self, 'SETTINGS').handlers.get('message')?.(reply as never, rinfoFor(reply) as never)
		expect(self.activeConnections.SETTINGS).toBe(true)
	})
})
