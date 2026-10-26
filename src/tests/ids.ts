/**
 * Branded identifiers for test fixtures. Production code only creates these at its edges (a
 * packet's sender, an mDNS record, a saved option); fixtures stand in for those edges.
 */

import {
	asChannelNumber,
	asDeviceIp,
	asDeviceName,
	type ChannelNumber,
	type DeviceIp,
	type DeviceName,
} from '../api/ids.js'

/** A device address. */
export const ip = (address: string): DeviceIp => asDeviceIp(address)

/** A device name. */
export const name = (deviceName: string): DeviceName => asDeviceName(deviceName)

/** A channel number. */
export const ch = (number: number): ChannelNumber => asChannelNumber(number)
