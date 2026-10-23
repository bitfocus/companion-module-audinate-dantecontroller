/**
 * The identifiers a Dante network is addressed by, as distinct types.
 *
 * Several of them are strings and a device can be named by any of them, which is how a name ended
 * up where an address belonged without anything noticing. Each gets its own brand, so mixing them
 * up is a compile error and the conversions live at the edges: a packet's sender, an mDNS record,
 * a saved action option.
 */

declare const brand: unique symbol

/** `T`, told apart from every other `T` by `Name`. Only the functions below create one. */
export type Branded<T, Name extends string> = T & { readonly [brand]: Name }

/**
 * The 64-bit Dante device id: 16 lower-case hex digits, from the `id` key of the device's
 * `_netaudio-cmc` mDNS TXT record.
 *
 * The one identifier a device keeps across renames and address changes - checked against Ultimo X2
 * hardware, where a rename re-announced the same id. On hardware it is the device's MAC address in
 * EUI-64 form or followed by a process number, so two Dante devices on one host still differ.
 */
export type DanteDeviceId = Branded<string, 'DanteDeviceId'>

/** The IPv4 address a device was discovered at. How it is reached, not who it is. */
export type DeviceIp = Branded<string, 'DeviceIp'>

/**
 * A device's Dante name. Unique on the network, but changed by a rename - and what Dante itself
 * routes by, so commands still carry it on the wire.
 */
export type DeviceName = Branded<string, 'DeviceName'>

/** A channel's 1-based number within its device, media type and direction. Stable across renames. */
export type ChannelNumber = Branded<number, 'ChannelNumber'>

const DEVICE_ID_PATTERN = /^[0-9a-f]{16}$/i

/** A device id from untrusted text, normalised to lower case. */
export function parseDanteDeviceId(value: unknown): DanteDeviceId | undefined {
	return typeof value === 'string' && DEVICE_ID_PATTERN.test(value) ? (value.toLowerCase() as DanteDeviceId) : undefined
}

/** Whether a stored value is already a device id. Saved options from 2.x hold names or addresses instead. */
export function isDanteDeviceId(value: unknown): value is DanteDeviceId {
	return typeof value === 'string' && DEVICE_ID_PATTERN.test(value) && value === value.toLowerCase()
}

/** An address the module already knows to be a device's. Trusted: it came from a socket or a record. */
export const asDeviceIp = (address: string): DeviceIp => address as DeviceIp

/** The sender of a packet. */
export const deviceIpOf = (rinfo: { address: string }): DeviceIp => asDeviceIp(rinfo.address)

/** A device name as a device or mDNS reported it. */
export const asDeviceName = (name: string): DeviceName => name as DeviceName

/** A channel number from untrusted input: a positive integer, given as a number or numeric text. */
export function parseChannelNumber(value: unknown): ChannelNumber | undefined {
	const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
	return typeof number === 'number' && Number.isInteger(number) && number >= 1 ? (number as ChannelNumber) : undefined
}

/** A channel number the module itself produced, counting `1..count`. */
export const asChannelNumber = (number: number): ChannelNumber => number as ChannelNumber

/** The channel numbers `1..count`. */
export function channelNumbers(count: number | undefined): ChannelNumber[] {
	return Array.from({ length: count ?? 0 }, (_, index) => asChannelNumber(index + 1))
}

/** `Object.entries` for records keyed by a branded string, which it would widen back to `string`. */
export function brandedEntries<Key extends string, Value>(record: Partial<Record<Key, Value>>): [Key, Value][] {
	return Object.entries(record).filter((entry) => entry[1] !== undefined) as [Key, Value][]
}

/** `Object.keys` for records keyed by a branded string. */
export function brandedKeys<Key extends string>(record: Partial<Record<Key, unknown>>): Key[] {
	return Object.keys(record) as Key[]
}
