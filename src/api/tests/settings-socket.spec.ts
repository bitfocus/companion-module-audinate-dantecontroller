import { describe, expect, it, vi, beforeEach } from 'vitest'
import type DanteInstance from '../../main.js'
import type { NetworkInterfaceInfo } from '../../config.js'

/**
 * Settings is the one service that both listens on a fixed port and sends unicast queries whose
 * replies return to that port. With two instances of this module on one host, a shared wildcard
 * bind means the OS hands one instance's reply to the other, which drops it as an unknown device -
 * so the asking instance silently never learns the device's sample rate, encoding or model. These
 * pin the bind topology that keeps the two instances apart.
 */

interface FakeSocket {
	handlers: Record<string, (...args: unknown[]) => void>
	on: ReturnType<typeof vi.fn>
	bind: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
	addMembership: ReturnType<typeof vi.fn>
	removeAllListeners: ReturnType<typeof vi.fn>
	send: ReturnType<typeof vi.fn>
}

const created: FakeSocket[] = []

vi.mock('node:dgram', () => {
	const createSocket = () => {
		const socket: FakeSocket = {
			handlers: {},
			on: vi.fn(),
			bind: vi.fn(),
			close: vi.fn(),
			addMembership: vi.fn(),
			removeAllListeners: vi.fn(),
			send: vi.fn(),
		}
		socket.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
			socket.handlers[event] = handler
			return socket
		})
		created.push(socket)
		return socket
	}
	return { default: { createSocket } }
})

vi.mock('multicast-dns', () => ({
	default: () => ({ on: vi.fn(), destroy: vi.fn(), removeAllListeners: vi.fn(), query: vi.fn() }),
}))

/** The chosen card, on a host that also carries a second Dante network on another card. */
const chosen: NetworkInterfaceInfo = {
	name: 'enX0',
	address: '172.16.0.17',
	mac: '3a:40:c8:f1:11:b2',
	netmask: '255.255.255.0',
}
const other: NetworkInterfaceInfo = {
	name: 'enX1',
	address: '172.16.3.20',
	mac: '36:9c:75:e3:e4:97',
	netmask: '255.255.255.0',
}

vi.mock('../../config.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../config.js')>()),
	listNetworkInterfaces: () => [chosen, other],
}))

const { initConnection, DanteConnection } = await import('../connection.js')
const { DANTE_CONST } = await import('../const.js')

function instance(mac: string): DanteInstance {
	const self: Record<string, unknown> = {
		config: { mac, interval: 0, timeoutInterval: 3000, variables: true, verbose: false },
		devicesData: {},
		devicesChoices: [],
		activeConnections: {},
		log: vi.fn(),
		updateStatus: vi.fn(),
		saveConfig: vi.fn(),
	}
	self.connection = new DanteConnection(self as unknown as DanteInstance)
	return self as unknown as DanteInstance
}

/** Every socket bound to the settings port, in creation order. */
function settingsPortSockets(): FakeSocket[] {
	return created.filter((socket) => socket.bind.mock.calls[0]?.[0] === DANTE_CONST.PORTS.INFO)
}

beforeEach(() => {
	created.length = 0
	vi.clearAllMocks()
})

describe('settings sockets with a card chosen', () => {
	it('binds the sending socket to the card address, so replies cannot be taken by another instance', () => {
		const self = instance(`${chosen.mac}|${chosen.address}`)

		initConnection(self)

		// A more specific bind outscores any wildcard bind in the OS's socket lookup.
		expect((self.sockets.SETTINGS as unknown as FakeSocket).bind).toHaveBeenCalledWith(
			DANTE_CONST.PORTS.INFO,
			chosen.address,
		)
	})

	it('adds a wildcard listener for the multicast group, which a card-bound socket cannot receive', () => {
		const self = instance(`${chosen.mac}|${chosen.address}`)

		initConnection(self)

		const listener = self.connection.settingsMulticast as unknown as FakeSocket
		expect(listener).toBeDefined()
		expect(listener.bind).toHaveBeenCalledWith(DANTE_CONST.PORTS.INFO)
		expect(listener.bind).not.toHaveBeenCalledWith(DANTE_CONST.PORTS.INFO, expect.anything())
		expect(settingsPortSockets()).toHaveLength(2)
	})

	it('joins the group on the listener rather than the sending socket', () => {
		const self = instance(`${chosen.mac}|${chosen.address}`)
		initConnection(self)
		const sender = self.sockets.SETTINGS as unknown as FakeSocket
		const listener = self.connection.settingsMulticast as unknown as FakeSocket

		sender.handlers.listening?.()
		listener.handlers.listening?.()

		expect(listener.addMembership).toHaveBeenCalledWith(DANTE_CONST.MULTICAST_IP.INFO, chosen.address)
		expect(sender.addMembership).not.toHaveBeenCalled()
	})

	it('reports the settings path usable only once both halves are up', () => {
		const self = instance(`${chosen.mac}|${chosen.address}`)
		initConnection(self)
		const sender = self.sockets.SETTINGS as unknown as FakeSocket
		const listener = self.connection.settingsMulticast as unknown as FakeSocket

		sender.handlers.listening?.()
		// the sending half alone leaves the module deaf to announcements
		expect(self.activeConnections.SETTINGS).toBe(false)

		listener.handlers.listening?.()
		expect(self.activeConnections.SETTINGS).toBe(true)
	})

	it('closes and forgets the listener, so a re-init does not leak it or rebind over it', () => {
		const self = instance(`${chosen.mac}|${chosen.address}`)
		initConnection(self)
		const listener = self.connection.settingsMulticast as unknown as FakeSocket

		self.connection.close()

		expect(listener.removeAllListeners).toHaveBeenCalled()
		expect(listener.close).toHaveBeenCalledTimes(1)
		expect(self.connection.settingsMulticast).toBeUndefined()
	})
})

describe('settings sockets with the card automatic', () => {
	it('uses one wildcard socket for both jobs, since there is no card to scope replies to', () => {
		const self = instance('')

		initConnection(self)

		expect((self.sockets.SETTINGS as unknown as FakeSocket).bind).toHaveBeenCalledWith(DANTE_CONST.PORTS.INFO)
		expect(self.connection.settingsMulticast).toBeUndefined()
		expect(settingsPortSockets()).toHaveLength(1)
	})

	it('joins the group on that socket, on every card', () => {
		const self = instance('')
		initConnection(self)
		const socket = self.sockets.SETTINGS as unknown as FakeSocket

		socket.handlers.listening?.()

		expect(socket.addMembership).toHaveBeenCalledWith(DANTE_CONST.MULTICAST_IP.INFO, chosen.address)
		expect(socket.addMembership).toHaveBeenCalledWith(DANTE_CONST.MULTICAST_IP.INFO, other.address)
		expect(self.activeConnections.SETTINGS).toBe(true)
	})
})
