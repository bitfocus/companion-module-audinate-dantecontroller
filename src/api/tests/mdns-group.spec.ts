import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type multidns from 'multicast-dns'
import { MdnsGroup, type MdnsGroupHandlers } from '../mdns-group.js'
import type { NetworkInterfaceInfo } from '../../config.js'

/**
 * mDNS on one socket per card.
 *
 * A single `multicast-dns` socket with no interface hears every card but sends out of one - `en0`
 * on macOS - so with the card automatic, devices on any other card were never asked and the
 * connection found nothing.
 */

const WIFI: NetworkInterfaceInfo = { name: 'en0', address: '192.168.0.102', mac: '', netmask: '255.255.255.0' }
const DANTE: NetworkInterfaceInfo = { name: 'en23', address: '192.168.1.100', mac: '', netmask: '255.255.255.0' }
const OTHER: NetworkInterfaceInfo = { name: 'en5', address: '10.0.0.2', mac: '', netmask: '255.0.0.0' }

type FakeSocket = EventEmitter & {
	nic: NetworkInterfaceInfo
	query: ReturnType<typeof vi.fn>
	destroy: ReturnType<typeof vi.fn>
}

function setup(): { group: MdnsGroup; sockets: FakeSocket[]; handlers: MdnsGroupHandlers } {
	const sockets: FakeSocket[] = []
	const handlers = {
		response: vi.fn(),
		ready: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		cardsChanged: vi.fn(),
	}
	const group = new MdnsGroup(handlers, (nic) => {
		const socket = Object.assign(new EventEmitter(), {
			nic,
			query: vi.fn((_query: unknown, callback?: (error: Error | null) => void) => callback?.(null)),
			destroy: vi.fn(),
		})
		sockets.push(socket)
		return socket as unknown as multidns.MulticastDNS
	})
	return { group, sockets, handlers }
}

const query = { questions: [{ name: '_netaudio-arc._udp.local', type: 'PTR' as const }] }

function respondFrom(socket: FakeSocket, address: string): void {
	socket.emit('response', { answers: [], additionals: [] }, { address, port: 5353, family: 'IPv4', size: 0 })
}

describe('MdnsGroup', () => {
	it('sends a query out of every card', () => {
		const { group, sockets } = setup()
		group.sync([WIFI, DANTE])
		group.query(query)

		expect(sockets.map((socket) => socket.nic.name)).toEqual(['en0', 'en23'])
		for (const socket of sockets) expect(socket.query).toHaveBeenCalledTimes(1)
	})

	it('follows cards appearing and going away', () => {
		const { group, sockets, handlers } = setup()
		group.sync([WIFI])

		// the Dante adapter is plugged in
		group.sync([WIFI, DANTE])
		expect(sockets).toHaveLength(2)
		expect(handlers.cardsChanged).toHaveBeenLastCalledWith([DANTE], [])

		// and unplugged again
		group.sync([WIFI])
		expect(sockets[1]?.destroy).toHaveBeenCalledTimes(1)
		expect(handlers.cardsChanged).toHaveBeenLastCalledWith([], [DANTE])
		expect(group.cards).toEqual([WIFI])

		// nothing changed, nothing reported
		handlers.cardsChanged = vi.fn()
		group.sync([WIFI])
		expect(handlers.cardsChanged).not.toHaveBeenCalled()
	})

	it('handles a response once, on the card whose subnet holds the device', () => {
		// Linux delivers group traffic to every wildcard-bound socket, whichever card it came in on
		const { group, sockets, handlers } = setup()
		group.sync([WIFI, DANTE])
		const [wifi, dante] = sockets as [FakeSocket, FakeSocket]

		respondFrom(wifi, '192.168.1.237')
		respondFrom(dante, '192.168.1.237')

		expect(handlers.response).toHaveBeenCalledTimes(1)
		const via = vi.mocked(handlers.response).mock.calls[0]?.[2]

		// a follow-up query goes back out of the card the device is on, and only that one
		via?.query(query)
		expect(dante.query).toHaveBeenCalledTimes(1)
		expect(wifi.query).not.toHaveBeenCalled()
	})

	it('handles a response on every card when no card holds the device', () => {
		// a link-local device seen from cards with routable addresses: either may be the one
		const { group, sockets, handlers } = setup()
		group.sync([WIFI, DANTE])
		for (const socket of sockets) respondFrom(socket, '169.254.10.20')
		expect(handlers.response).toHaveBeenCalledTimes(2)
	})

	it('reports a card that cannot send once, until it sends again', () => {
		const { group, sockets } = setup()
		group.sync([WIFI])
		const socket = sockets[0]
		const failure = new Error('send EHOSTUNREACH')
		socket.query.mockImplementation((_query: unknown, callback?: (error: Error | null) => void) => callback?.(failure))

		const onError = vi.fn()
		for (let sweep = 0; sweep < 5; sweep++) group.query(query, onError)
		expect(onError).toHaveBeenCalledTimes(1)
		expect(onError.mock.calls[0]?.[0]?.message).toBe('en0 (192.168.0.102) : send EHOSTUNREACH')

		// it recovers, then fails again: that is news
		socket.query.mockImplementationOnce((_query: unknown, callback?: (error: Error | null) => void) => callback?.(null))
		group.query(query, onError)
		group.query(query, onError)
		expect(onError).toHaveBeenCalledTimes(2)
	})

	it('is down only once every card has failed', () => {
		const { group, sockets, handlers } = setup()
		group.sync([WIFI, DANTE, OTHER])
		const bindFailure = new Error('bind EADDRINUSE')

		sockets[0]?.emit('error', bindFailure)
		sockets[1]?.emit('error', bindFailure)
		expect(vi.mocked(handlers.error).mock.calls.map((call) => call[2])).toEqual([false, false])

		// a failed card is no longer asked to send
		group.query(query)
		expect(sockets[0]?.query).not.toHaveBeenCalled()
		expect(sockets[2]?.query).toHaveBeenCalledTimes(1)

		sockets[2]?.emit('error', bindFailure)
		expect(vi.mocked(handlers.error).mock.calls[2]?.[2]).toBe(true)
	})

	it('reports readiness per card', () => {
		const { group, sockets, handlers } = setup()
		group.sync([WIFI, DANTE])
		sockets[1]?.emit('ready')
		expect(handlers.ready).toHaveBeenCalledWith(DANTE)
	})

	it('closes every socket on destroy, and survives a late error from one', () => {
		const { group, sockets, handlers } = setup()
		group.sync([WIFI, DANTE])
		group.removeAllListeners()
		group.destroy()

		for (const socket of sockets) expect(socket.destroy).toHaveBeenCalledTimes(1)
		// an 'error' with no listener would throw out of the socket and take the process down
		expect(() => sockets[0]?.emit('error', new Error('late'))).not.toThrow()
		expect(handlers.error).not.toHaveBeenCalled()

		// and it stays closed
		group.sync([WIFI, DANTE, OTHER])
		expect(sockets).toHaveLength(2)
	})
})
