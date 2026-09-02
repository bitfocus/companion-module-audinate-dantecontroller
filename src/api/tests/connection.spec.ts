import { describe, expect, it, vi } from 'vitest'
import type dgram from 'node:dgram'
import { DanteConnection } from '../connection.js'
import type DanteInstance from '../../main.js'

/**
 * The connection owns the state the module's teardown bugs lived in: sockets closed twice,
 * listeners left attached across a re-init, timers outliving the instance. These pin the
 * invariants `close()` exists to enforce.
 */

function fakeSocket() {
	return {
		close: vi.fn(),
		removeAllListeners: vi.fn(),
	} as unknown as dgram.Socket
}

function fakeMdns() {
	return { destroy: vi.fn(), removeAllListeners: vi.fn() }
}

function connection() {
	const self = { log: vi.fn(), updateStatus: vi.fn() } as unknown as DanteInstance
	return new DanteConnection(self)
}

describe('DanteConnection', () => {
	it('starts with nothing open', () => {
		const c = connection()
		expect(c.sockets).toEqual({})
		expect(c.mdns).toBeUndefined()
		expect(c.connected).toBe(false)
		expect(c.configError).toBeNull()
	})

	it('closes every socket it holds', () => {
		const c = connection()
		const arc = fakeSocket()
		const cmc = fakeSocket()
		c.sockets = { ARC: arc, CMC: cmc }

		c.close()
		expect(arc.close).toHaveBeenCalledTimes(1)
		expect(cmc.close).toHaveBeenCalledTimes(1)
	})

	it('drops socket listeners before closing, so a late event cannot report a stale status', () => {
		const c = connection()
		const arc = fakeSocket()
		c.sockets = { ARC: arc }

		c.close()
		expect(arc.removeAllListeners).toHaveBeenCalled()
		// order matters: 'close' fires asynchronously, after this call has returned
		const removeOrder = (arc.removeAllListeners as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		const closeOrder = (arc.close as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		expect(removeOrder).toBeLessThan(closeOrder)
	})

	it('survives a socket that is already closed', () => {
		const c = connection()
		const arc = fakeSocket()
		;(arc.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw Object.assign(new Error('not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' })
		})
		c.sockets = { ARC: arc }

		expect(() => c.close()).not.toThrow()
	})

	it('is idempotent - closing twice does not close a socket twice', () => {
		const c = connection()
		const arc = fakeSocket()
		c.sockets = { ARC: arc }

		c.close()
		c.close()
		expect(arc.close).toHaveBeenCalledTimes(1)
	})

	it('destroys mdns and forgets it', () => {
		const c = connection()
		const mdns = fakeMdns()
		c.mdns = mdns as never

		c.close()
		expect(mdns.removeAllListeners).toHaveBeenCalled()
		expect(mdns.destroy).toHaveBeenCalledTimes(1)
		expect(c.mdns).toBeUndefined()
	})

	it('clears the discovery interval, so no timer outlives the connection', () => {
		vi.useFakeTimers()
		try {
			const c = connection()
			const fired = vi.fn()
			c.interval = setInterval(fired, 100)

			c.close()
			vi.advanceTimersByTime(1000)
			expect(fired).not.toHaveBeenCalled()
			expect(c.interval).toBeNull()
		} finally {
			vi.useRealTimers()
		}
	})

	it('leaves nothing behind that a later open would have to clean up', () => {
		const c = connection()
		c.sockets = { ARC: fakeSocket() }
		c.mdns = fakeMdns() as never
		c.interval = setInterval(() => {}, 1000)

		c.close()
		expect(c.sockets).toEqual({})
		expect(c.mdns).toBeUndefined()
		expect(c.interval).toBeNull()
	})

	it('forgets the chosen card, so a re-init cannot filter discovery against a stale subnet', () => {
		const c = connection()
		c.boundInterface = { name: 'enX0', address: '172.16.0.17', mac: '3a:40:c8:f1:11:b2', netmask: '255.255.255.0' }
		// and the once-per-source log has to speak again for a connection that starts over
		c.ignoredSources.add('172.16.3.20')

		c.close()
		expect(c.boundInterface).toBeUndefined()
		expect(c.ignoredSources.size).toBe(0)
	})
})

/**
 * The silence watchdog.
 *
 * Its reason to exist is a fault that reports nothing: a multicast membership lapses and the sockets
 * stay bound, unerrored and Ok while no traffic reaches them again. Nothing re-joins a group after
 * the initial 'listening' handler, so without this the module stays deaf until someone restarts the
 * connection by hand.
 */
describe('DanteConnection silence watchdog', () => {
	const THRESHOLD_MS = 30_000

	/**
	 * A connection whose `open` is stubbed to do what the real one does to this state.
	 *
	 * `initConnection` closes first and arms a fresh watchdog before it returns, so the stub does
	 * both. Closing alone would leave no watchdog running afterwards, and the once-per-outage test
	 * below would then pass because no timer was left to fire rather than because the reset disarmed
	 * it - which is the property actually worth pinning.
	 */
	function watched(config?: { interval: number; timeoutInterval: number }, timeout = 0) {
		const self = { log: vi.fn(), updateStatus: vi.fn(), config, timeout } as unknown as DanteInstance
		const c = new DanteConnection(self)
		// `noteTraffic` reaches `checkConnections`, which reads this state off the instance - the real
		// one forwards to the connection (see the accessors on DanteInstance), so the fake must too
		Object.defineProperty(self, 'activeConnections', { get: () => c.activeConnections })
		Object.defineProperty(self, 'configError', { get: () => c.configError })
		Object.defineProperty(self, 'CONNECTED', {
			get: () => c.connected,
			set: (value: boolean) => (c.connected = value),
		})
		const open = vi.fn(() => {
			c.close()
			c.startWatchdog()
		})
		c.open = open
		return { c, open }
	}

	function withFakeTimers(body: () => void) {
		vi.useFakeTimers()
		try {
			body()
		} finally {
			vi.useRealTimers()
		}
	}

	it('stays quiet on a network that has never had any traffic to lose', () => {
		withFakeTimers(() => {
			const { c, open } = watched()
			c.startWatchdog()

			vi.advanceTimersByTime(THRESHOLD_MS * 10)
			expect(open).not.toHaveBeenCalled()
			c.close()
		})
	})

	it('stays quiet while traffic keeps arriving', () => {
		withFakeTimers(() => {
			const { c, open } = watched()
			c.startWatchdog()

			// a heartbeat every second, as a live Dante network produces
			for (let i = 0; i < THRESHOLD_MS / 1000 + 30; i++) {
				c.noteTraffic('HEARTBEAT')
				vi.advanceTimersByTime(1000)
			}
			expect(open).not.toHaveBeenCalled()
			c.close()
		})
	})

	it('reopens the connection once the silence passes the threshold', () => {
		withFakeTimers(() => {
			const { c, open } = watched()
			c.startWatchdog()
			c.noteTraffic('HEARTBEAT')

			vi.advanceTimersByTime(THRESHOLD_MS - 1000)
			expect(open).not.toHaveBeenCalled()

			vi.advanceTimersByTime(THRESHOLD_MS)
			expect(open).toHaveBeenCalledTimes(1)
		})
	})

	it('attempts recovery once per outage, not once per window', () => {
		withFakeTimers(() => {
			const { c, open } = watched()
			c.startWatchdog()
			c.noteTraffic('HEARTBEAT')

			// devices all powered off overnight: the reopen cannot help, and must not keep firing
			vi.advanceTimersByTime(THRESHOLD_MS * 20)
			expect(open).toHaveBeenCalledTimes(1)
		})
	})

	it('arms again once traffic returns, so a second outage is also recovered', () => {
		withFakeTimers(() => {
			const { c, open } = watched()
			c.startWatchdog()
			c.noteTraffic('HEARTBEAT')
			vi.advanceTimersByTime(THRESHOLD_MS * 2)
			expect(open).toHaveBeenCalledTimes(1)

			// the reopen worked - traffic is back, and a later outage is a new one
			c.noteTraffic('HEARTBEAT')
			vi.advanceTimersByTime(THRESHOLD_MS * 2)
			expect(open).toHaveBeenCalledTimes(2)
		})
	})

	it('scales the threshold with the poll interval, so slow polling is not called silence', () => {
		withFakeTimers(() => {
			// polling once a minute: 30s of quiet is normal, not a fault
			const { c, open } = watched({ interval: 60_000, timeoutInterval: 300_000 })
			c.startWatchdog()
			c.noteTraffic('HEARTBEAT')

			vi.advanceTimersByTime(THRESHOLD_MS * 2)
			expect(open).not.toHaveBeenCalled()

			vi.advanceTimersByTime(60_000 * 5)
			expect(open).toHaveBeenCalledTimes(1)
		})
	})

	it('does not restart before a long device timeout has had a chance to fire', () => {
		withFakeTimers(() => {
			const { c, open } = watched({ interval: 1000, timeoutInterval: 120_000 }, 120_000)
			c.startWatchdog()
			c.noteTraffic('HEARTBEAT')

			vi.advanceTimersByTime(THRESHOLD_MS * 2)
			expect(open).not.toHaveBeenCalled()
			c.close()
		})
	})

	it('stops on close, so no watchdog outlives the connection', () => {
		withFakeTimers(() => {
			const { c, open } = watched()
			c.startWatchdog()
			c.noteTraffic('HEARTBEAT')

			c.close()
			expect(c.watchdog).toBeNull()
			vi.advanceTimersByTime(THRESHOLD_MS * 10)
			expect(open).not.toHaveBeenCalled()
		})
	})

	it('forgets the last packet time on close, so a reopened connection starts disarmed', () => {
		const { c } = watched()
		c.noteTraffic('HEARTBEAT')
		expect(c.lastPacketAt).toBeGreaterThan(0)

		c.close()
		expect(c.lastPacketAt).toBe(0)
	})

	it('replaces an existing watchdog rather than stacking a second one', () => {
		withFakeTimers(() => {
			const { c, open } = watched()
			c.startWatchdog()
			const first = c.watchdog
			c.startWatchdog()

			expect(c.watchdog).not.toBe(first)
			c.noteTraffic('HEARTBEAT')
			vi.advanceTimersByTime(THRESHOLD_MS * 2)
			// one reopen, not one per timer left running
			expect(open).toHaveBeenCalledTimes(1)
		})
	})
})
