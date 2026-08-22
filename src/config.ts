import { networkInterfaces } from 'node:os'
import type { DropdownChoice, SomeCompanionConfigField } from '@companion-module/base'

export const UPDATE_MINIMUM = 250
/**
 * Dante devices advertise their SRV records with a 120s TTL, and RFC 6762 has a resolver refresh an
 * active query at 80% of that - so a poll slower than ~96s leaves the module's view of the network
 * staler than the records it is built from. 60s stays clear of that, and keeps the timeout it
 * implies (twice the interval) at the TTL rather than beyond it.
 */
export const UPDATE_MAXIMUM = 60000

export const TIMEOUT_MINIMUM = 1000
/**
 * Long enough to ride out a badly lossy network, short enough that an unplugged device does not sit
 * on a button looking healthy. Beyond this the module is not reporting the network, it is
 * remembering it.
 */
export const TIMEOUT_MAXIMUM = 300000

export type ModuleConfig = {
	/**
	 * The chosen network card, as `mac|address`.
	 *
	 * Named for the hardware address because that is what identifies the card across reboots and
	 * lease changes. Empty means automatic, resolved per device. Configurations saved before this held a bare
	 * IPv4 address; those still resolve, and are rewritten to the `mac|address` form on first
	 * connect - see `resolveConfiguredInterface`.
	 */
	mac: string
	interval: number
	timeoutInterval: number
	/**
	 * Whether to publish a Companion variable per device property.
	 *
	 * When false the module still tracks every device property - the Device Property feedback reads
	 * the same values - it simply does not create variables for them.
	 */
	variables: boolean
	verbose: boolean
}

/** One IPv4 address on one network card. */
export interface NetworkInterfaceInfo {
	/** Interface name, e.g. `en8`. */
	name: string
	address: string
	/** Lower-case, colon-separated. May be all zeroes on some virtual interfaces. */
	mac: string
	netmask: string
}

/** Every external IPv4 address on this machine, with the card it belongs to. */
export function listNetworkInterfaces(): NetworkInterfaceInfo[] {
	const found: NetworkInterfaceInfo[] = []
	const nets = networkInterfaces()
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] ?? []) {
			// Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses.
			// @types/node still types `family` as the literal 'IPv4'/'IPv6', but on Node 18+ it is
			// actually reported as the number 4 or 6 at runtime - check against whichever this Node returns.
			const familyV4Value: string | number = typeof net.family === 'string' ? 'IPv4' : 4
			if ((net.family as unknown as string | number) === familyV4Value && !net.internal) {
				found.push({
					name,
					address: net.address,
					mac: (net.mac ?? '').toLowerCase(),
					netmask: net.netmask ?? '',
				})
			}
		}
	}
	return found
}

/** A MAC that identifies no real card, and so cannot be used to find one again. */
function isUsableMac(mac: string): boolean {
	return mac !== '' && mac !== '00:00:00:00:00:00'
}

/**
 * The config value stored for a chosen network card.
 *
 * An address alone is not a stable identity: a link-local or DHCP card gets a different one after
 * a reboot or lease change, and the module then cannot bind. The MAC survives that, so it is
 * stored alongside the address and used to find the card again when the address has moved. The
 * address is kept as well, so a card carrying several addresses still resolves to the chosen one.
 */
export function encodeInterfaceId(nic: NetworkInterfaceInfo): string {
	return isUsableMac(nic.mac) ? `${nic.mac}|${nic.address}` : nic.address
}

export interface ResolvedInterface {
	nic: NetworkInterfaceInfo
	/**
	 * `address` - the stored address is still present.
	 * `mac` - the address moved and the card was found by its MAC instead.
	 */
	matchedBy: 'address' | 'mac'
}

/**
 * Finds the configured network card among those currently present.
 *
 * Accepts both the `mac|address` form and a bare address, so configurations saved before the MAC
 * was recorded keep working. Returns undefined for an empty value, which means "all interfaces".
 */
export function resolveConfiguredInterface(
	configValue: string,
	available: NetworkInterfaceInfo[],
): ResolvedInterface | undefined {
	if (!configValue) return undefined

	const separator = configValue.indexOf('|')
	const mac = separator === -1 ? '' : configValue.slice(0, separator).toLowerCase()
	const address = separator === -1 ? configValue : configValue.slice(separator + 1)

	// Prefer the exact address: on a card with several addresses it is the one that was chosen.
	const byAddress = available.find((nic) => nic.address === address)
	if (byAddress) return { nic: byAddress, matchedBy: 'address' }

	// The address moved. Find the same card by MAC and use whatever address it holds now.
	if (isUsableMac(mac)) {
		const byMac = available.find((nic) => nic.mac === mac)
		if (byMac) return { nic: byMac, matchedBy: 'mac' }
	}

	return undefined
}

/**
 * The timeout the module actually uses, which is never less than two poll intervals.
 *
 * A device that broadcasts heartbeats is kept alive by those whatever the poll is doing, but one
 * only seen through discovery - a software controller, for instance - is kept alive solely by the
 * poll. If its timeout can expire between two polls it drops and is rediscovered in a loop,
 * rebuilding every action and feedback definition each time. Two intervals leaves room for one late
 * or lost reply, so a configured value below that is raised rather than obeyed.
 */
export function effectiveTimeout(config: Pick<ModuleConfig, 'interval' | 'timeoutInterval'>): number {
	return Math.max(config.timeoutInterval, config.interval * 2)
}

/** Shows the timeout warning field exactly when `effectiveTimeout` would override the configured value. */
const TIMEOUT_WARNING_EXPRESSION = `$(options:timeoutInterval) < $(options:interval) * 2`

export function GetConfigFields(): SomeCompanionConfigField[] {
	// "Automatic" rather than "All": the module listens on every interface for discovery, but a
	// command to a device is sent carrying the address of the one card that reaches it. Nothing acts
	// on all interfaces at once, so naming it that way invited the wrong expectation.
	const nicChoices: DropdownChoice<string>[] = [{ id: '', label: 'Automatic (detect per device)' }]
	for (const nic of listNetworkInterfaces()) {
		nicChoices.push({ id: encodeInterfaceId(nic), label: `${nic.name} : ${nic.address}` })
	}

	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: '',
			value: 'This module controls Dante devices on the selected network.',
		},

		{
			type: 'dropdown',
			label: 'Network card',
			id: 'mac',
			description:
				'Choose the network card bound to Dante Controller, or leave on Automatic to use whichever ' +
				'card reaches each device. A chosen card is remembered by its MAC address, so the ' +
				'connection keeps working if its IP changes (link-local or DHCP).',
			width: 12,
			choices: nicChoices,
			default: nicChoices[0]?.id ?? '',
		},

		{
			type: 'number',
			id: 'interval',
			label: 'Update Interval',
			description: 'The time in milliseconds to periodically discover new devices.',
			width: 3,
			default: 1000,
			min: UPDATE_MINIMUM,
			max: UPDATE_MAXIMUM,
			asInteger: true,
			disableAutoExpression: true,
		},

		{
			type: 'number',
			id: 'timeoutInterval',
			label: 'Timeout Interval',
			description:
				'The time in milliseconds before a device is considered offline. Set this to at least twice ' +
				'the Update Interval, or devices that do not send heartbeats may drop and reappear between polls.',
			width: 3,
			default: 3000,
			min: TIMEOUT_MINIMUM,
			max: TIMEOUT_MAXIMUM,
			asInteger: true,
			disableAutoExpression: true,
		},

		{
			type: 'static-text',
			id: 'timeoutWarning',
			label: 'Warning',
			width: 6,
			value:
				'The Timeout Interval is less than twice the Update Interval, so a device that does not ' +
				'send heartbeats can time out between two polls and be dropped. Twice the Update Interval ' +
				'is being used instead.',
			isVisibleExpression: TIMEOUT_WARNING_EXPRESSION,
		},

		{
			type: 'checkbox',
			id: 'variables',
			label: 'Create Module Variables',
			description:
				'Publish a variable for every device property. Turn this off to keep the connection light ' +
				'and read device properties through the Device Property feedback instead.',
			width: 12,
			default: true,
		},

		{
			type: 'checkbox',
			id: 'verbose',
			label: 'Verbose Logging',
			width: 12,
			default: false,
			description: `Enabling this option will put more detail in the log, which can be useful for troubleshooting purposes.`,
		},
	]
}

/** An IPv4 dotted-quad as a 32-bit number, or undefined if it is not one. */
function toUint32(address: string): number | undefined {
	const parts = address.split('.')
	if (parts.length !== 4) return undefined

	let value = 0
	for (const part of parts) {
		const octet = Number(part)
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
		value = (value << 8) | octet
	}
	return value >>> 0
}

/**
 * The network card whose subnet contains `address`.
 *
 * Used when the card is chosen automatically rather than explicitly: a command still needs one
 * card's hardware address for its settings commands, and the card that can actually reach a
 * discovered device is the right one. Returns undefined if no card's subnet matches.
 */
export function findInterfaceForAddress(
	available: NetworkInterfaceInfo[],
	address: string,
): NetworkInterfaceInfo | undefined {
	const target = toUint32(address)
	if (target === undefined) return undefined

	return available.find((nic) => {
		const mask = toUint32(nic.netmask)
		const own = toUint32(nic.address)
		if (mask === undefined || own === undefined || mask === 0) return false
		return (own & mask) >>> 0 === (target & mask) >>> 0
	})
}
