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
