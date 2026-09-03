/**
 * The device registry: what is on the network, how it is identified, and the debounced work that
 * republishes definitions and variables when it changes.
 */

import { debounce, throttle, type DebouncedFunc } from 'es-toolkit/compat'
import { createModuleLogger } from '@companion-module/base'
import { UpdateActions } from '../actions.js'
import { UpdateFeedbacks } from '../feedbacks.js'
import { UpdateVariableDefinitions, CheckVariables } from '../variables.js'
import { listNetworkInterfaces, findInterfaceForAddress } from '../config.js'
import type DanteInstance from '../main.js'
import type {
	DeviceData,
	AudioRxChannelSource,
	AudioTxChannel,
	AudioRxChannel,
	ChannelMediaType,
	VideoRxChannelSource,
	VideoTxChannel,
	VideoRxChannel,
} from './types.js'
import { isSubscriptionConnected } from './protocol-rules.js'
import type { DanteDeviceVariables } from '../types.js'
import { insertDeviceChoice } from './choices.js'

const logger = createModuleLogger('api:devices')

//**
//** Types
//**

/** @returns The channel's friendly name if set, otherwise its plain name. */
export function getChannelSubscriptionName(
	channel: { friendlyName?: string; name?: string } | undefined,
): string | undefined {
	return channel?.friendlyName || channel?.name
}

/** @returns True if the device has at least one rx (destination) channel. */
/**
 * The device properties exposed as module variables, and offered by the Device Property feedback.
 *
 * One list so the two cannot drift: every entry here is both a `<device>_<property>` variable and a
 * selectable property on the feedback.
 *
 * Kept in alphabetical order, which is the order the picker and its expression description present
 * them in - both derive from this array, so they cannot disagree.
 */
export const DEVICE_PROPERTIES = [
	'dante_model',
	'dante_software_build',
	'dante_software_version',
	'encoding',
	'hardware_build',
	'hardware_version',
	'ip',
	'latency',
	'locked',
	'manufacturer',
	'manufacturer_short',
	'model_name',
	'output_levels',
	'product_version',
	'pullup',
	'rx',
	'rx_names',
	'rx_names_video',
	'rx_video',
	'software_build',
	'software_version',
	'sr',
	'tx',
	'tx_names',
	'tx_names_video',
	'tx_video',
] as const satisfies readonly (keyof DanteDeviceVariables)[]

export type DeviceProperty = (typeof DEVICE_PROPERTIES)[number]

/** Human-readable labels for the property picker. */
export const DEVICE_PROPERTY_LABELS: Record<DeviceProperty, string> = {
	ip: 'IP address',
	locked: 'Locked',
	rx: 'Receive channel count',
	tx: 'Transmit channel count',
	rx_names: 'Receive channel names',
	tx_names: 'Transmit channel names',
	rx_video: 'Video receive channel count',
	tx_video: 'Video transmit channel count',
	rx_names_video: 'Video receive channel names',
	tx_names_video: 'Video transmit channel names',
	sr: 'Sample rate',
	latency: 'Latency (ms)',
	pullup: 'Sample rate pullup',
	encoding: 'Encoding',
	output_levels: 'Output levels',
	model_name: 'Model name',
	product_version: 'Product version',
	dante_model: 'Dante model',
	dante_software_version: 'Dante software version',
	hardware_version: 'Hardware version',
	manufacturer: 'Manufacturer',
	manufacturer_short: 'Manufacturer (short)',
	software_version: 'Software version',
	software_build: 'Software build',
	dante_software_build: 'Dante software build',
	hardware_build: 'Hardware build',
}

/**
 * Channel names of one direction, indexed from 0, as the `_rx_names`/`_tx_names` (and their
 * `_video` counterparts) variables hold them.
 */
function channelNames(device: DeviceData, channelType: 'rx' | 'tx', mediaType: ChannelMediaType = 'audio'): string[] {
	const io =
		mediaType === 'video'
			? channelType === 'rx'
				? device.videoRx
				: device.videoTx
			: channelType === 'rx'
				? device.audioRx
				: device.audioTx
	const names: string[] = []
	for (let i = 0; i < (io?.count ?? 0); i++) {
		const channel = io?.[i + 1]
		names[i] = (channelType === 'tx' ? getChannelSubscriptionName(channel) : channel?.name) ?? ''
	}
	return names
}

/**
 * Formats a version triple, or undefined when the device has not reported one.
 *
 * Without the undefined check an unreported version renders as the string
 * 'undefined.undefined.undefined', which reads as data rather than as absence.
 */
function formatVersion(major?: number, minor?: number, patch?: number): string | undefined {
	if (major === undefined && minor === undefined && patch === undefined) return undefined
	return `${major ?? 0}.${minor ?? 0}.${patch ?? 0}`
}

function computeDeviceProperty(device: DeviceData, ip: string, property: DeviceProperty): unknown {
	switch (property) {
		case 'ip':
			return ip
		case 'locked':
			return device.locked
		case 'rx':
			return device.audioRx?.count
		case 'tx':
			return device.audioTx?.count
		case 'rx_video':
			return device.videoRx?.count
		case 'tx_video':
			return device.videoTx?.count
		case 'rx_names_video':
			return channelNames(device, 'rx', 'video')
		case 'tx_names_video':
			return channelNames(device, 'tx', 'video')
		case 'rx_names':
			return channelNames(device, 'rx')
		case 'tx_names':
			return channelNames(device, 'tx')
		case 'model_name':
			return device.modelName
		case 'product_version':
			// `||` not `??`: devices report an empty string here as often as nothing at all, and an
			// empty version is absence, not a value
			return (
				device.productVersionString ||
				formatVersion(device.productVersionMajor, device.productVersionMinor, device.productVersionPatch)
			)
		case 'dante_model':
			return device.danteModel
		case 'dante_software_version':
			return formatVersion(
				device.danteSoftwareVersionMajor,
				device.danteSoftwareVersionMinor,
				device.danteSoftwareVersionPatch,
			)
		case 'hardware_version':
			return formatVersion(device.hardwareVersionMajor, device.hardwareVersionMinor, device.hardwareVersionPatch)
		case 'manufacturer':
			return device.manufacturer
		case 'manufacturer_short':
			return device.manfShortName
		case 'software_version':
			return formatVersion(device.softwareVersionMajor, device.softwareVersionMinor, device.softwareVersionPatch)
		case 'software_build':
			return device.softwareVersionBuild
		case 'dante_software_build':
			return device.danteSoftwareVersionBuild
		case 'hardware_build':
			return device.hardwareVersionBuild
		default:
			return device[property]
	}
}

/**
 * Reads one property of one device, in the form the corresponding module variable holds it.
 *
 * Shared by `CheckVariables` and the Device Property feedback, so a value can never be reported one
 * way as a variable and another way as a feedback.
 *
 * The single cast is the boundary between a switch returning a union and a signature naming the
 * exact type per property; every branch above is checked against `DanteDeviceVariables`.
 */
export function deviceProperty<Property extends DeviceProperty>(
	device: DeviceData,
	ip: string,
	property: Property,
): DanteDeviceVariables[Property] | undefined {
	return computeDeviceProperty(device, ip, property) as DanteDeviceVariables[Property] | undefined
}

export function hasAudioRxChannels(device: DeviceData | undefined): boolean {
	return (device?.audioRx?.count ?? 0) > 0
}

/** @returns True if the device has at least one tx (source) channel. */
export function hasAudioTxChannels(device: DeviceData | undefined): boolean {
	return (device?.audioTx?.count ?? 0) > 0
}

/** @returns True if the device has at least one video rx (destination) channel. */
export function hasVideoRxChannels(device: DeviceData | undefined): boolean {
	return (device?.videoRx?.count ?? 0) > 0
}

/** @returns True if the device has at least one video tx (source) channel. */
export function hasVideoTxChannels(device: DeviceData | undefined): boolean {
	return (device?.videoTx?.count ?? 0) > 0
}

/** @returns The IP address of the device with this name, if known. */
export function findDeviceIpByName(self: DanteInstance, deviceName: string): string | undefined {
	for (const [ip, device] of Object.entries(self.devicesData)) {
		if (device?.name == deviceName) {
			return ip
		}
	}
	return undefined
}

/** Finds a tx channel by name (or friendly name) on a device, identified by IP or device name. */
export function findAudioTxChannelByName(
	self: DanteInstance,
	deviceIdentifier: string,
	channelName: string,
): AudioTxChannel | undefined {
	let device: DeviceData | undefined = self.devicesData[deviceIdentifier]
	if (!device) {
		const deviceIp = findDeviceIpByName(self, deviceIdentifier)
		device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	}
	if (!device?.audioTx) {
		return undefined
	}
	// `audioTx`/`audioRx` also carry a non-numeric `count` property alongside the numeric channel
	// keys, so Object.entries()'s value type includes it too - the isNaN check filters it out.
	for (const [channelNumber, channel] of Object.entries(device.audioTx)) {
		if (isNaN(Number(channelNumber))) continue
		const txChannel = channel as AudioTxChannel
		if (txChannel?.name == channelName || txChannel?.friendlyName == channelName) {
			return txChannel
		}
	}
	return undefined
}

/** Finds an rx channel by name on a device, identified by IP or device name. */
export function findAudioRxChannelByName(
	self: DanteInstance,
	deviceIdentifier: string,
	channelName: string,
): AudioRxChannel | undefined {
	let device: DeviceData | undefined = self.devicesData[deviceIdentifier]
	if (!device) {
		const deviceIp = findDeviceIpByName(self, deviceIdentifier)
		device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	}
	if (!device?.audioRx) {
		return undefined
	}
	for (const [channelNumber, channel] of Object.entries(device.audioRx)) {
		if (isNaN(Number(channelNumber))) continue
		const rxChannel = channel as AudioRxChannel
		if (rxChannel?.name == channelName) {
			return rxChannel
		}
	}
	return undefined
}

/** Finds a video tx channel by name on a device, identified by IP or device name. */
export function findVideoTxChannelByName(
	self: DanteInstance,
	deviceIdentifier: string,
	channelName: string,
): VideoTxChannel | undefined {
	let device: DeviceData | undefined = self.devicesData[deviceIdentifier]
	if (!device) {
		const deviceIp = findDeviceIpByName(self, deviceIdentifier)
		device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	}
	if (!device?.videoTx) {
		return undefined
	}
	// `videoTx`/`videoRx` also carry a non-numeric `count` property alongside the numeric channel
	// keys, so Object.entries()'s value type includes it too - the isNaN check filters it out.
	for (const [channelNumber, channel] of Object.entries(device.videoTx)) {
		if (isNaN(Number(channelNumber))) continue
		if ((channel as VideoTxChannel)?.name == channelName) {
			return channel as VideoTxChannel
		}
	}
	return undefined
}

/** Finds a video rx channel by name on a device, identified by IP or device name. */
export function findVideoRxChannelByName(
	self: DanteInstance,
	deviceIdentifier: string,
	channelName: string,
): VideoRxChannel | undefined {
	let device: DeviceData | undefined = self.devicesData[deviceIdentifier]
	if (!device) {
		const deviceIp = findDeviceIpByName(self, deviceIdentifier)
		device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	}
	if (!device?.videoRx) {
		return undefined
	}
	for (const [channelNumber, channel] of Object.entries(device.videoRx)) {
		if (isNaN(Number(channelNumber))) continue
		if ((channel as VideoRxChannel)?.name == channelName) {
			return channel as VideoRxChannel
		}
	}
	return undefined
}

/**
 * Cancels every device's pending offline timeout.
 *
 * Must be called before `devicesData` is reset or the instance is torn down: the timers hold a
 * closure over `self` and the device IP, so an orphaned one fires up to `timeoutInterval` later
 * and calls `destroyDevice` for an IP that fresh discovery has since re-registered - silently
 * removing a device that is present and responding.
 */
export function clearDeviceTimeouts(self: DanteInstance): void {
	for (const device of Object.values(self.devicesData)) {
		clearTimeout(device?.timeoutArray?.[0])
	}
}

/**
 * Reads what a device's rx channel is currently subscribed to, for the learn callbacks.
 *
 * Returns undefined when the channel is unrouted or the device is unknown, so a learn can decline
 * to change anything rather than writing empty values over the user's settings.
 *
 * A self-route is reported by the device as the '.' shorthand rather than its own name; that is
 * resolved here so callers always get a name they can match against `devicesChoices`.
 */
export function getAudioRxChannelSource(
	self: DanteInstance,
	deviceIdentifier: string,
	channelNumber: number,
): AudioRxChannelSource | undefined {
	const deviceIp = self.devicesData[deviceIdentifier] ? deviceIdentifier : findDeviceIpByName(self, deviceIdentifier)
	const device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	const channel = device?.audioRx?.[channelNumber]
	if (!channel?.sourceDevice || !channel.sourceChannel) {
		return undefined
	}

	return {
		deviceName: channel.sourceDevice === '.' ? (device?.name ?? channel.sourceDevice) : channel.sourceDevice,
		channelName: channel.sourceChannel,
		connected: isSubscriptionConnected(channel.subscriptionStatus),
	}
}

/**
 * Reads what a device's video rx channel is currently subscribed to.
 *
 * See {@link getAudioRxChannelSource}, which this mirrors for the `AV_EXTENDED` protocol's video
 * channels - except there is no '.' self-route shorthand to resolve here, since that has not been
 * observed on video subscriptions.
 */
export function getVideoRxChannelSource(
	self: DanteInstance,
	deviceIdentifier: string,
	channelNumber: number,
): VideoRxChannelSource | undefined {
	const deviceIp = self.devicesData[deviceIdentifier] ? deviceIdentifier : findDeviceIpByName(self, deviceIdentifier)
	const device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	const channel = device?.videoRx?.[channelNumber]
	if (!channel?.sourceDevice || !channel.sourceChannel) {
		return undefined
	}

	return { deviceName: channel.sourceDevice, channelName: channel.sourceChannel }
}

/**
 * Resolves a device identifier to its address.
 *
 * Accepts either a device name or an IP. Dropdowns store the name, because a device's address is
 * reassigned by DHCP and link-local autoconfiguration while its name is chosen by the user and
 * persists - but actions saved before that store an address, and those keep working through here.
 */
export function resolveDeviceIp(self: DanteInstance, identifier: string): string | undefined {
	if (!identifier) return undefined
	if (self.devicesData[identifier]) return identifier
	return findDeviceIpByName(self, identifier)
}

/**
 * `name (ip)` for log lines, or the address alone for a device discovered but not yet named.
 *
 * Logs are read by someone matching what they see against a device list and a patch panel, so both
 * halves matter: the name is what they recognise, the address is what they can ping.
 */
export function deviceLabel(self: DanteInstance, deviceIp: string): string {
	const name = self.devicesData[deviceIp]?.name
	return name ? `${name} (${deviceIp})` : deviceIp
}

/** The device record behind an identifier, which may be a name or an IP. */
export function deviceByIdentifier(self: DanteInstance, identifier: string): DeviceData | undefined {
	const ip = resolveDeviceIp(self, identifier)
	return ip !== undefined ? self.devicesData[ip] : undefined
}

/** Registers a newly-seen Dante device in `devicesData`, arming an offline timeout if configured. */
/**
 * Records which card reaches `deviceIp`, when the network card is being chosen automatically.
 *
 * Settings and CMC commands embed a hardware address and devices ignore commands carrying an
 * all-zero one, so without this an automatic configuration would discover and route but never read
 * a device's settings. Resolved per device rather than once for the instance: with Dante devices on
 * more than one network a single address is wrong for all but one of them, and which one it
 * happened to be depended on mDNS reply ordering.
 *
 * Stored as a hex string rather than a Buffer because device records pass through `merge()`.
 */
function resolveDeviceInterface(self: DanteInstance, deviceIp: string): string | undefined {
	// An explicitly chosen card is honoured for every device.
	if (self.config.mac) return undefined

	const nic = findInterfaceForAddress(listNetworkInterfaces(), deviceIp)
	if (!nic?.mac) return undefined

	logger.info(`Reaching ${deviceIp} via ${nic.name} (${nic.address})`)
	return nic.mac.replaceAll(':', '')
}

/**
 * The hardware address to put in a command addressed to `deviceIp`.
 *
 * Falls back to the instance address, which is the explicitly configured card when there is one.
 */
export function macForDevice(self: DanteInstance, device: string): Buffer {
	const deviceMac = deviceByIdentifier(self, device)?.interfaceMac
	return deviceMac ? Buffer.from(deviceMac, 'hex') : self.mac
}

export function registerDevice(self: DanteInstance, deviceIp: string, deviceName: string): DeviceData {
	self.devicesData[deviceIp] = {
		name: deviceName,
		ports: {},
		interfaceMac: resolveDeviceInterface(self, deviceIp),
	}
	const currDevice = self.devicesData[deviceIp]

	// timeout function to destroy reference if device is offline too long
	if (self.timeout > 0 && !currDevice.timeoutArray) {
		// embed timeout object into array to avoid circular references with merge function
		currDevice.timeoutArray = [
			setTimeout(() => {
				destroyDevice(self, deviceIp)
			}, self.timeout),
		]
	}

	if (self.debug) {
		logger.debug(
			`${deviceName} (${deviceIp}) registered` +
				(self.timeout > 0 ? `, offline timeout armed at ${self.timeout}ms` : ', no offline timeout'),
		)
	}

	insertDeviceChoice(self, deviceIp, deviceName)
	return currDevice
}

/**
 * Removes a device (considered offline) from `devicesData` and its associated dropdown choices,
 * then rebuilds action/feedback/variable definitions.
 */
export function destroyDevice(self: DanteInstance, deviceIp: string): void {
	const deviceName = self.devicesData[deviceIp]?.name
	logger.warn(`${deviceName ?? deviceIp} (${deviceIp}) went offline - nothing heard for ${self.timeout}ms`)

	// Everything below is keyed by name, and another address may still be announcing this one - see
	// `devicesByName`. The common case is a device whose address changed: it re-registers under the
	// new one immediately, and this fires for the old record a timeout later. Deleting by name then
	// would strip the channel choices and the dropdown entry of a device that is still online.
	const nameStillOnline =
		deviceName !== undefined &&
		Object.entries(self.devicesData).some(([ip, device]) => ip !== deviceIp && device.name === deviceName)

	// The channel choice lists are deliberately *kept*. They are what `channelFieldDevices` builds
	// per-device option fields from, and an option id missing from a definition loses the value
	// stored against it - so clearing them here silently emptied the channel selection on every
	// action and feedback pointing at this device, permanently, for a device that had merely blipped.
	// See `channelFieldDevices` in choices.ts for the full reasoning.
	//
	// They are bounded by the number of distinct device names seen, and `initConnection` clears them
	// outright, so a decommissioned device is forgotten on the next reconnect rather than lingering
	// for the life of the process.
	//
	// Note the consequence for the rebuild path: a device returning with unchanged channels no longer
	// makes `updateChannelChoices`/`updateVideoChannelChoices` see a change, so neither schedules a
	// rebuild. That is correct - the fields never went away, so there is nothing to rebuild - and
	// registration still schedules one for the device dropdown below.

	// delete device choice, which is keyed by name
	if (deviceName !== undefined && !nameStillOnline) {
		const index = self.devicesChoices.findIndex((choice) => choice.id === deviceName)
		if (index !== -1) {
			self.devicesChoices.splice(index, 1)
		}
	}

	//delete timeout
	clearTimeout(self.devicesData[deviceIp]?.timeoutArray?.[0])
	channelSettleDeadlines.get(self)?.delete(deviceIp)

	// delete object from devicesData
	delete self.devicesData[deviceIp]

	scheduleUpdateData(self)
}

/** Resets a device's offline timeout, keeping it from being considered offline. */
export function keepAlive(self: DanteInstance, deviceIp: string): void {
	const toArray = self.devicesData[deviceIp]?.timeoutArray
	if (toArray) {
		clearTimeout(toArray[0])
		if (self.timeout > 0) {
			toArray[0] = setTimeout(() => {
				destroyDevice(self, deviceIp)
			}, self.timeout)
		}
	}
}

/**
 * How long the definition rebuild waits for the flurry of discovery replies to settle.
 * Long enough to coalesce a device's registration, name, and paged channel replies into one
 * rebuild; short enough that a single device appearing still feels immediate.
 *
 * Sized against the slowest reply measured on real hardware rather than a round number: one device
 * here answers the encoding query almost exactly a second after the sample-rate query it was sent
 * alongside, and a window shorter than that split every startup into two rebuilds.
 *
 * Exported so tests advance the clock by the real window instead of restating it.
 */
export const UPDATE_DEBOUNCE_MS = 1000

/**
 * Upper bound on how long a rebuild can be deferred. On a large network the replies never stop
 * arriving for long enough to reach the debounce window, so without this the dropdowns would
 * stay empty for the whole of discovery. This guarantees visible progress every 10s instead.
 */
export const UPDATE_MAX_WAIT_MS = 10_000

/** One debounced rebuild per instance. Weakly held so a discarded instance is still collectable. */
const debouncedUpdates = new WeakMap<DanteInstance, DebouncedFunc<() => void>>()

function getDebouncedUpdate(self: DanteInstance): DebouncedFunc<() => void> {
	let debounced = debouncedUpdates.get(self)
	if (!debounced) {
		debounced = debounce(() => updateData(self), UPDATE_DEBOUNCE_MS, { maxWait: UPDATE_MAX_WAIT_MS })
		debouncedUpdates.set(self, debounced)
	}
	return debounced
}

/**
 * Requests a definition rebuild, coalescing bursts of requests into a single one.
 *
 * Discovery calls this once per device registration, once per name, and once per 32-channel page
 * in each direction, while every rebuild re-serialises the definitions for *all* devices to the
 * Companion host - so the uncoalesced cost is quadratic in network size. Prefer this over calling
 * `updateData` directly for anything on the discovery path.
 */
export function scheduleUpdateData(self: DanteInstance): void {
	getDebouncedUpdate(self)()
}

/** Drops any pending rebuild, for when the state it would publish is being torn down or replaced. */
export function cancelUpdateData(self: DanteInstance): void {
	debouncedUpdates.get(self)?.cancel()
}

/** Runs any pending rebuild immediately. */
export function flushUpdateData(self: DanteInstance): void {
	debouncedUpdates.get(self)?.flush()
}

/**
 * How often variable values may be pushed to Companion. Short enough that a fader move or a
 * subscription change still feels instant, long enough to collapse the burst of per-channel-page
 * replies a single device emits into one push.
 */
const VARIABLES_THROTTLE_MS = 30

/**
 * Pending variable work, accumulated between throttle ticks.
 *
 * A plain `throttle(CheckVariables)` would be wrong: throttling invokes with the *last* arguments,
 * so a scoped update for device A arriving just before one for device B would silently discard A.
 * Instead every request is unioned in here and the tick applies the combined result.
 */
interface PendingVariables {
	ips: Set<string>
	/** A request arrived with no IP, so every device needs refreshing. */
	allDevices: boolean
	types: Set<string>
	/** A request arrived with no explicit types, so every category needs refreshing. */
	allTypes: boolean
}

const pendingVariables = new WeakMap<DanteInstance, PendingVariables>()

const throttledVariables = new WeakMap<DanteInstance, DebouncedFunc<() => void>>()

function flushCheckVariables(self: DanteInstance): void {
	const pending = pendingVariables.get(self)
	if (!pending) return
	pendingVariables.delete(self)

	const types = pending.allTypes ? [] : [...pending.types]

	// Collapse to a single unscoped sweep once more than one device is waiting: CheckVariables walks
	// every device regardless (to rebuild the `devices` list), so N scoped calls cost about the same
	// as one unscoped call but push N separate setVariableValues payloads instead of one.
	if (pending.allDevices || pending.ips.size > 1) {
		CheckVariables(self, undefined, ...types)
	} else if (pending.ips.size === 1) {
		CheckVariables(self, [...pending.ips][0], ...types)
	}
}

function getThrottledVariables(self: DanteInstance): DebouncedFunc<() => void> {
	let throttled = throttledVariables.get(self)
	if (!throttled) {
		throttled = throttle(() => flushCheckVariables(self), VARIABLES_THROTTLE_MS, {
			// leading so the first change in a quiet period lands immediately, trailing so the last
			// change in a busy one is never dropped
			leading: true,
			trailing: true,
		})
		throttledVariables.set(self, throttled)
	}
	return throttled
}

/**
 * Requests a variable refresh, coalescing requests within {@link VARIABLES_THROTTLE_MS} into a
 * single push to Companion. Arguments match {@link CheckVariables} and are unioned across the
 * window rather than overwritten.
 */
export function scheduleCheckVariables(self: DanteInstance, ipAddress?: string, ...variableTypes: string[]): void {
	let pending = pendingVariables.get(self)
	if (!pending) {
		pending = { ips: new Set(), allDevices: false, types: new Set(), allTypes: false }
		pendingVariables.set(self, pending)
	}

	if (ipAddress === undefined) {
		pending.allDevices = true
	} else {
		pending.ips.add(ipAddress)
	}

	if (variableTypes.length === 0) {
		pending.allTypes = true
	} else {
		for (const variableType of variableTypes) {
			pending.types.add(variableType)
		}
	}

	getThrottledVariables(self)()
}

/** Drops any pending variable refresh, for when the state it would publish is going away. */
export function cancelCheckVariables(self: DanteInstance): void {
	throttledVariables.get(self)?.cancel()
	pendingVariables.delete(self)
}

/**
 * Which devices each live feedback instance depends on, keyed by feedback instance id.
 *
 * Both routing feedbacks read two devices: the destination (its rx channel's subscription status
 * and source labels) and the source (its tx channel's name/friendlyName/number, used to match
 * against what the destination reports). So a change to *either* device can flip the result, and
 * indexing on destination alone would leave feedbacks stale whenever a source device renamed a
 * transmit channel.
 */
const feedbackDevices = new WeakMap<DanteInstance, Map<string, Set<string>>>()

/**
 * Feedbacks whose devices could not be resolved - a manual feedback naming a device that is not
 * discovered yet, or whose name came from a variable that does not resolve. They are checked on
 * every tick, since we cannot tell whether they are affected.
 */
const wildcardFeedbacks = new WeakMap<DanteInstance, Set<string>>()

interface PendingFeedbacks {
	devices: Set<string>
	/** Something changed that is not attributable to one device, so check everything. */
	allDevices: boolean
}

const pendingFeedbacks = new WeakMap<DanteInstance, PendingFeedbacks>()

const throttledFeedbacks = new WeakMap<DanteInstance, DebouncedFunc<() => void>>()

/**
 * Records which devices a feedback instance depends on, so later changes to those devices can
 * re-check just this feedback instead of every feedback of its type.
 *
 * Called from the feedback callbacks, which are the only place the resolved device identities are
 * known - `@companion-module/base` 2.x has no `subscribe` hook. Companion re-runs a callback when
 * its options or referenced variables change, so the mapping stays current.
 *
 * @param deviceIps The devices this feedback reads; any `undefined` entry marks it as a wildcard.
 */
export function trackFeedbackDevices(self: DanteInstance, feedbackId: string, deviceIps: (string | undefined)[]): void {
	let byId = feedbackDevices.get(self)
	if (!byId) {
		byId = new Map()
		feedbackDevices.set(self, byId)
	}

	let wildcards = wildcardFeedbacks.get(self)
	if (!wildcards) {
		wildcards = new Set()
		wildcardFeedbacks.set(self, wildcards)
	}

	const resolved = new Set<string>()
	let unresolved = false
	for (const ip of deviceIps) {
		if (ip) {
			resolved.add(ip)
		} else {
			unresolved = true
		}
	}

	byId.set(feedbackId, resolved)
	if (unresolved) {
		wildcards.add(feedbackId)
	} else {
		wildcards.delete(feedbackId)
	}
}

/** Forgets a feedback instance that Companion has removed or disabled. */
export function untrackFeedback(self: DanteInstance, feedbackId: string): void {
	feedbackDevices.get(self)?.delete(feedbackId)
	wildcardFeedbacks.get(self)?.delete(feedbackId)
}

function flushCheckFeedbacks(self: DanteInstance): void {
	const pending = pendingFeedbacks.get(self)
	if (!pending) return
	pendingFeedbacks.delete(self)

	const byId = feedbackDevices.get(self)

	// Nothing tracked yet means no feedback callback has run, so we have no ids to target. Fall back
	// to the type-level check, which is also what a full rebuild wants.
	if (pending.allDevices || !byId || byId.size === 0) {
		self.checkAllFeedbacks()
		return
	}

	// A Set, not an array: a wildcard feedback is also present in `byId` (one end resolved, the other
	// not), so it would otherwise be emitted twice whenever its resolved device is the one that changed.
	const ids = new Set<string>(wildcardFeedbacks.get(self))
	for (const [feedbackId, devices] of byId) {
		for (const deviceIp of devices) {
			if (pending.devices.has(deviceIp)) {
				ids.add(feedbackId)
				break
			}
		}
	}

	if (ids.size > 0) {
		self.checkFeedbacksById(...ids)
	}
}

function getThrottledFeedbacks(self: DanteInstance): DebouncedFunc<() => void> {
	let throttled = throttledFeedbacks.get(self)
	if (!throttled) {
		throttled = throttle(() => flushCheckFeedbacks(self), VARIABLES_THROTTLE_MS, {
			leading: true,
			trailing: true,
		})
		throttledFeedbacks.set(self, throttled)
	}
	return throttled
}

/**
 * Requests a feedback re-check, coalescing requests within {@link VARIABLES_THROTTLE_MS}.
 *
 * @param deviceIp The device whose data changed. Omit to re-check every feedback, for changes that
 * are not attributable to a single device (such as a full definitions rebuild).
 */
export function scheduleCheckFeedbacks(self: DanteInstance, deviceIp?: string): void {
	let pending = pendingFeedbacks.get(self)
	if (!pending) {
		pending = { devices: new Set(), allDevices: false }
		pendingFeedbacks.set(self, pending)
	}

	if (deviceIp === undefined) {
		pending.allDevices = true
	} else {
		pending.devices.add(deviceIp)
	}

	getThrottledFeedbacks(self)()
}

/** Drops any pending feedback re-check, for when the state it would evaluate is going away. */
export function cancelCheckFeedbacks(self: DanteInstance): void {
	throttledFeedbacks.get(self)?.cancel()
	pendingFeedbacks.delete(self)
}

/**
 * How long after asking a device for its channels its channel list is treated as still filling in.
 *
 * Generous next to how long the replies actually take (a burst of pages answered in tens of
 * milliseconds), and short enough that it is not a meaningful blind spot: the window only opens
 * when the module itself asks - at discovery, when a channel count changes, and on the Refresh
 * action - so a rename made by hand at any other time is reported as usual.
 */
const CHANNEL_SETTLE_MS = 3000

/** Per instance, when each device's channel list stops being treated as still filling in. */
const channelSettleDeadlines = new WeakMap<DanteInstance, Map<string, number>>()

/**
 * Notes that a device has just been asked for its channels, so the replies that follow are its
 * channel list being filled in rather than changing.
 *
 * A device answers a channel query in pages, and its transmit names arrive over two replies (the
 * channel names, then the friendly names that supersede them where set) - so a list is built up
 * over several replies, every one of which looks like a change to the one before it. Without this
 * a 32-channel device logs a rename line per channel per page on discovery, drowning the log at
 * the exact moment an operator is reading it, and saying nothing: nobody renamed anything.
 */
export function markChannelsSettling(self: DanteInstance, deviceIp: string): void {
	let deadlines = channelSettleDeadlines.get(self)
	if (!deadlines) {
		deadlines = new Map()
		channelSettleDeadlines.set(self, deadlines)
	}
	deadlines.set(deviceIp, Date.now() + CHANNEL_SETTLE_MS)
}

/** Whether {@link markChannelsSettling}'s window is still open for this device. */
export function channelsAreSettling(self: DanteInstance, deviceIp: string): boolean {
	return (channelSettleDeadlines.get(self)?.get(deviceIp) ?? 0) > Date.now()
}

/** Rebuilds and re-registers this instance's actions, variables, and feedbacks after device data changes. */
export function updateData(self: DanteInstance): void {
	if (self.debug) {
		logger.debug(`Rebuilding definitions for ${Object.keys(self.devicesData).length} device(s)`)
	}
	UpdateActions(self)
	UpdateVariableDefinitions(self)
	CheckVariables(self)
	UpdateFeedbacks(self)
	// a full rebuild is not attributable to one device
	scheduleCheckFeedbacks(self)
}
