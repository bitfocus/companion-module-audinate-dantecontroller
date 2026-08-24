import { describe, expect, it, vi, beforeEach } from 'vitest'
import type DanteInstance from '../../main.js'

/**
 * `self.timeout` is what every device's expiry timer is set from, and it has to be the effective
 * value rather than the configured one. The two have drifted apart before - the class owning the
 * timer while a free function read a different field - so pin the wiring, not just the arithmetic.
 */

vi.mock('node:dgram', () => {
	const createSocket = () => ({
		on: vi.fn(),
		bind: vi.fn(),
		close: vi.fn(),
		removeAllListeners: vi.fn(),
		addMembership: vi.fn(),
		setMulticastTTL: vi.fn(),
		setBroadcast: vi.fn(),
		send: vi.fn(),
		address: () => ({ address: '0.0.0.0', family: 'IPv4', port: 0 }),
	})
	return { default: { createSocket } }
})

vi.mock('multicast-dns', () => ({
	default: () => ({ on: vi.fn(), destroy: vi.fn(), removeAllListeners: vi.fn(), query: vi.fn() }),
}))

const warn = vi.fn()
vi.mock('@companion-module/base', async (importOriginal) => ({
	...(await importOriginal<typeof import('@companion-module/base')>()),
	// the override is announced through the module logger, which is otherwise invisible to a test
	createModuleLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}))

const { initConnection, DanteConnection } = await import('../connection.js')

function instance(interval: number, timeoutInterval: number): DanteInstance {
	// Assembled as a plain object and cast once at the end, rather than cast first and then given a
	// connection: `connection` is readonly on DanteInstance, which the real class satisfies by
	// building it in the field initialiser from `this`. A test double has the same chicken-and-egg -
	// DanteConnection needs the instance - so the connection goes on while this is still a plain
	// object, which is also what the class does, just without the field-initialiser sugar.
	const self: Record<string, unknown> = {
		// 'Automatic' - no card to resolve, so nothing here depends on the host's interfaces
		config: { mac: '', interval, timeoutInterval, variables: true, verbose: false },
		devicesData: {},
		activeConnections: {},
		log: vi.fn(),
		updateStatus: vi.fn(),
		saveConfig: vi.fn(),
	}
	self.connection = new DanteConnection(self as unknown as DanteInstance)
	return self as unknown as DanteInstance
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('initConnection sets the device timeout', () => {
	it('uses the configured timeout when it is at least two poll intervals', () => {
		const self = instance(1000, 3000)
		initConnection(self)
		expect(self.timeout).toBe(3000)
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Timeout Interval'))
	})

	it('falls back to twice the update interval when the configured timeout is shorter', () => {
		const self = instance(5000, 2000)
		initConnection(self)
		expect(self.timeout).toBe(10000)
	})

	it('logs the value it used instead, so the change is not silent', () => {
		const self = instance(5000, 2000)
		initConnection(self)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('10000ms is being used instead'))
	})

	it('never leaves a timeout that can expire between two polls', () => {
		for (const [interval, timeoutInterval] of [
			[250, 1000],
			[1000, 1500],
			[2000, 1000],
			[3600000, 1000],
		]) {
			const self = instance(interval, timeoutInterval)
			initConnection(self)
			expect(self.timeout, `${interval}/${timeoutInterval}`).toBeGreaterThanOrEqual(interval * 2)
		}
	})
})
