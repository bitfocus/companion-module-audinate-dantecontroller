/**
 * Resolving the names a subscription reports to the device and channel that actually carry it.
 */

import type DanteInstance from '../main.js'
import { getChannelSubscriptionName } from './devices.js'
import type { ChannelMediaType } from './types.js'
import {
	brandedEntries,
	channelNumbers,
	type ChannelNumber,
	type DanteDeviceId,
	type DeviceIp,
	type DeviceName,
} from './ids.js'

/**
 * Transmit channel numbers by name, per device id and media type, for every name each channel has
 * had since the connection started. Lower-cased: Dante names are case-insensitive.
 *
 * A receiver keeps the names it subscribed with after the transmitter is renamed, and keeps
 * receiving from it - measured on Ultimo X2 hardware, status stayed connected for as long as was
 * watched after both a device and a transmit channel rename. So to say where a route really comes
 * from, the old names have to stay resolvable. Cleared with `deviceIdsByName` on reconnect.
 */
const txNamesByInstance = new WeakMap<DanteInstance, Map<string, Map<string, ChannelNumber>>>()

const historyKey = (deviceId: DanteDeviceId, mediaType: ChannelMediaType) => `${deviceId}|${mediaType}`

/** Forgets every remembered name, for a fresh connection. */
export function resetChannelNameHistory(self: DanteInstance): void {
	txNamesByInstance.delete(self)
}

/** The device id of a device name, current or former. */
export function deviceIdForName(self: DanteInstance, name: string): DanteDeviceId | undefined {
	const ids = self.deviceIdsByName ?? {}
	const exact = ids[name as DeviceName]
	if (exact !== undefined) return exact
	const wanted = name.toLowerCase()
	return brandedEntries(ids).find(([candidate]) => candidate.toLowerCase() === wanted)?.[1]
}

/**
 * Remembers the current transmit channel names of the device at `deviceIp`, once its id is known.
 * Called whenever its transmit channels or its id are learnt; cheap when nothing is new.
 */
export function rememberTxChannelNames(self: DanteInstance, deviceIp: DeviceIp): void {
	const device = self.devicesData[deviceIp]
	const deviceId = device?.id
	if (!device || deviceId === undefined) return

	let history = txNamesByInstance.get(self)
	if (!history) {
		history = new Map()
		txNamesByInstance.set(self, history)
	}

	const remember = (mediaType: ChannelMediaType, channel: ChannelNumber, ...names: (string | undefined)[]) => {
		const key = historyKey(deviceId, mediaType)
		let byName = history.get(key)
		if (!byName) {
			byName = new Map()
			history.set(key, byName)
		}
		for (const name of names) {
			if (name) byName.set(name.toLowerCase(), channel)
		}
	}

	for (const channel of channelNumbers(device.audioTx?.count)) {
		const tx = device.audioTx?.[channel]
		// both: a subscription names the friendly name when there is one, but may predate it
		remember('audio', channel, tx?.name, getChannelSubscriptionName(tx))
	}
	for (const channel of channelNumbers(device.videoTx?.count)) {
		remember('video', channel, device.videoTx?.[channel]?.name)
	}
}

/**
 * The transmit channel a subscription comes from, as `<device id>/<channel number>`, or undefined
 * when it cannot be told: the source device's id has never been seen, or the channel name was never
 * one of its channels.
 *
 * A current channel name wins over a former one, so a name that has since moved to another channel
 * resolves to where it is now - which is also where the receiver will reconnect to.
 */
/** A subscription's source as `<device id>/<transmit channel number>`. */
export type SubscriptionSourceId = `${DanteDeviceId}/${ChannelNumber}`

export function resolveSubscriptionSource(
	self: DanteInstance,
	source: { deviceName: string; channelName: string },
	mediaType: ChannelMediaType,
): SubscriptionSourceId | undefined {
	const deviceId = deviceIdForName(self, source.deviceName)
	if (deviceId === undefined) return undefined
	const wanted = source.channelName.toLowerCase()

	for (const [, device] of brandedEntries(self.devicesData)) {
		if (device.id !== deviceId) continue
		const channels = mediaType === 'video' ? device.videoTx : device.audioTx
		for (const channel of channelNumbers(channels?.count)) {
			const tx = channels?.[channel]
			const names = mediaType === 'video' ? [tx?.name] : [getChannelSubscriptionName(tx), tx?.name]
			if (names.some((name) => name?.toLowerCase() === wanted)) return `${deviceId}/${channel}`
		}
	}

	const channel = txNamesByInstance.get(self)?.get(historyKey(deviceId, mediaType))?.get(wanted)
	return channel === undefined ? undefined : `${deviceId}/${channel}`
}
