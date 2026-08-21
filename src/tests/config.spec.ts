import { describe, expect, it } from 'vitest'
import {
	encodeInterfaceId,
	resolveConfiguredInterface,
	findInterfaceForAddress,
	type NetworkInterfaceInfo,
} from '../config.js'

const dante: NetworkInterfaceInfo = {
	name: 'en8',
	address: '169.254.109.120',
	mac: 'dc:04:5a:06:41:44',
	netmask: '255.255.0.0',
}
const lan: NetworkInterfaceInfo = {
	name: 'en0',
	address: '10.1.1.40',
	mac: 'b2:0c:97:40:6e:84',
	netmask: '255.255.255.0',
}

/** The same card after a reboot handed it a different link-local address. */
const danteRenumbered: NetworkInterfaceInfo = { ...dante, address: '169.254.238.244' }

describe('encodeInterfaceId', () => {
	it('records the hardware address alongside the current one', () => {
		expect(encodeInterfaceId(dante)).toBe('dc:04:5a:06:41:44|169.254.109.120')
	})

	it('falls back to the address alone for a card with no usable hardware address', () => {
		expect(
			encodeInterfaceId({ name: 'utun4', address: '192.168.33.3', mac: '00:00:00:00:00:00', netmask: '255.255.255.0' }),
		).toBe('192.168.33.3')
		expect(encodeInterfaceId({ name: 'utun4', address: '192.168.33.3', mac: '', netmask: '255.255.255.0' })).toBe(
			'192.168.33.3',
		)
	})
})

describe('resolveConfiguredInterface', () => {
	it('matches the stored address when it is still present', () => {
		const resolved = resolveConfiguredInterface(encodeInterfaceId(dante), [lan, dante])
		expect(resolved?.nic).toEqual(dante)
		expect(resolved?.matchedBy).toBe('address')
	})

	it('finds the card by hardware address after its IP changed', () => {
		// the reported case: machine rebooted, link-local address moved
		const resolved = resolveConfiguredInterface(encodeInterfaceId(dante), [danteRenumbered, lan])
		expect(resolved?.nic.address).toBe('169.254.238.244')
		expect(resolved?.matchedBy).toBe('mac')
	})

	it('prefers the stored address over another address on the same card', () => {
		// a card holding two addresses must resolve to the one that was chosen
		const second: NetworkInterfaceInfo = { ...dante, address: '169.254.99.9' }
		const resolved = resolveConfiguredInterface(encodeInterfaceId(dante), [second, dante])
		expect(resolved?.nic.address).toBe('169.254.109.120')
		expect(resolved?.matchedBy).toBe('address')
	})

	it('accepts a bare address saved before the hardware address was recorded', () => {
		const resolved = resolveConfiguredInterface('169.254.109.120', [lan, dante])
		expect(resolved?.nic).toEqual(dante)
		expect(resolved?.matchedBy).toBe('address')
	})

	it('is case-insensitive about the hardware address', () => {
		const resolved = resolveConfiguredInterface('DC:04:5A:06:41:44|169.254.109.120', [danteRenumbered])
		expect(resolved?.matchedBy).toBe('mac')
	})

	it('returns undefined for an empty value, which means all interfaces', () => {
		expect(resolveConfiguredInterface('', [dante, lan])).toBeUndefined()
	})

	it('returns undefined when the card is genuinely gone', () => {
		expect(resolveConfiguredInterface(encodeInterfaceId(dante), [lan])).toBeUndefined()
	})

	it('does not match on an all-zero hardware address', () => {
		// several virtual interfaces report 00:00:00:00:00:00, which identifies nothing
		const tunnelA: NetworkInterfaceInfo = {
			name: 'utun4',
			address: '192.168.33.3',
			mac: '00:00:00:00:00:00',
			netmask: '255.255.255.0',
		}
		const tunnelB: NetworkInterfaceInfo = {
			name: 'utun7',
			address: '192.168.44.4',
			mac: '00:00:00:00:00:00',
			netmask: '255.255.255.0',
		}
		expect(resolveConfiguredInterface('00:00:00:00:00:00|192.168.33.3', [tunnelB])).toBeUndefined()
		expect(resolveConfiguredInterface('00:00:00:00:00:00|192.168.33.3', [tunnelA])?.matchedBy).toBe('address')
	})

	it('does not confuse two different cards', () => {
		const resolved = resolveConfiguredInterface(encodeInterfaceId(lan), [danteRenumbered, lan])
		expect(resolved?.nic).toEqual(lan)
	})
})

describe('findInterfaceForAddress', () => {
	it('picks the card whose subnet contains the device', () => {
		// link-local is a /16, so the Dante card matches anything in 169.254.x.x
		expect(findInterfaceForAddress([lan, dante], '169.254.8.100')?.name).toBe('en8')
		expect(findInterfaceForAddress([lan, dante], '10.1.1.99')?.name).toBe('en0')
	})

	it('respects the netmask rather than guessing from the leading octets', () => {
		// en0 is a /24, so a 10.1.2.x address is not on it
		expect(findInterfaceForAddress([lan], '10.1.2.50')).toBeUndefined()
		expect(findInterfaceForAddress([lan], '10.1.1.50')?.name).toBe('en0')
	})

	it('returns undefined when nothing routes to the address', () => {
		expect(findInterfaceForAddress([lan, dante], '192.0.2.10')).toBeUndefined()
	})

	it('ignores a card with no usable netmask', () => {
		const broken: NetworkInterfaceInfo = { name: 'x', address: '10.1.1.5', mac: 'aa:bb:cc:dd:ee:ff', netmask: '' }
		expect(findInterfaceForAddress([broken], '10.1.1.6')).toBeUndefined()
	})

	it('rejects malformed addresses rather than matching them', () => {
		expect(findInterfaceForAddress([lan], 'not-an-ip')).toBeUndefined()
		expect(findInterfaceForAddress([lan], '10.1.1')).toBeUndefined()
		expect(findInterfaceForAddress([lan], '10.1.1.999')).toBeUndefined()
	})

	it('handles a high first octet without sign trouble', () => {
		// a naive 32-bit shift makes 200.x.x.x negative and the comparison unreliable
		const high: NetworkInterfaceInfo = {
			name: 'en9',
			address: '200.1.1.1',
			mac: 'a1:b2:c3:d4:e5:f6',
			netmask: '255.255.255.0',
		}
		expect(findInterfaceForAddress([high], '200.1.1.9')?.name).toBe('en9')
		expect(findInterfaceForAddress([high], '200.1.2.9')).toBeUndefined()
	})
})
