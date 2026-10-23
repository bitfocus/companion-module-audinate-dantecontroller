/**
 * Branded identifiers for test fixtures. Production code only creates these at its edges (a
 * packet's sender, an mDNS record, a saved option); fixtures stand in for those edges.
 */

import {
	asChannelNumber,
	asDeviceIp,
	asDeviceName,
	parseDanteDeviceId,
	type ChannelNumber,
	type DanteDeviceId,
	type DeviceIp,
	type DeviceName,
} from '../api/ids.js'

/** A device address. */
export const ip = (address: string): DeviceIp => asDeviceIp(address)

/** A device name. */
export const name = (deviceName: string): DeviceName => asDeviceName(deviceName)

/** A channel number. */
export const ch = (number: number): ChannelNumber => asChannelNumber(number)

/**
 * A device id: `001dc1fffe` followed by `suffix` as six hex digits, the EUI-64 MAC form real
 * Ultimo devices advertise. Distinct suffixes give distinct devices.
 */
export function id(suffix: number): DanteDeviceId {
	const deviceId = parseDanteDeviceId(`001dc1fffe${suffix.toString(16).padStart(6, '0')}`)
	if (deviceId === undefined) throw new Error(`No device id for suffix ${suffix}`)
	return deviceId
}
