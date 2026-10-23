import { createModuleLogger, type CompanionVariableDefinitions } from '@companion-module/base'
import {
	channelFieldDevices,
	deviceProperty,
	getAudioRxChannelSource,
	getChannelSubscriptionName,
	getVideoRxChannelSource,
	resolveSubscriptionSource,
	type DeviceData,
} from './api/index.js'
import { routingVariablesEnabled, variableKeysOf } from './config.js'
import type { DanteVariableValues } from './types.js'
import type DanteInstance from './main.js'
import { sanitiseVariableId } from './utils/sanitise.js'
import { VariablePublisher } from './variable-publisher.js'
import { brandedEntries, channelNumbers, type DanteDeviceId, type DeviceIp, type DeviceName } from './api/ids.js'

const logger = createModuleLogger('variables')

const publishers = new WeakMap<DanteInstance, VariablePublisher>()

/**
 * The instance's publisher. Every variable push goes through it, so a value that has not changed
 * is never sent twice. Created on first use so test doubles of the instance need no setup.
 */
export function variablePublisher(self: DanteInstance): VariablePublisher {
	let publisher = publishers.get(self)
	if (!publisher) {
		publisher = new VariablePublisher(self)
		publishers.set(self, publisher)
	}
	return publisher
}

/**
 * Builds the set of variable definitions for all known devices and publishes it, if it changed.
 *
 * The schema makes `devices` a required key, which is why a set without it needs the cast. An
 * empty set is still published, so turning both options off removes the variables a previous run
 * created.
 */
export function UpdateVariableDefinitions(self: DanteInstance): void {
	const variables = {} as CompanionVariableDefinitions<DanteVariableValues>

	if (self.config.variables) {
		variables.devices = { name: 'Dante Devices' }
		addDevicePropertyDefinitions(self, variables)
	}
	if (routingVariablesEnabled(self.config)) {
		addRoutingDefinitions(self, variables)
	}

	variablePublisher(self).setDefinitions(variables)
}

/**
 * The prefix of every variable id for a device, per the `variableKeys` option: its id, or its name
 * made safe for Companion. Undefined when the device does not have that yet - a device whose id has
 * not arrived publishes no id-keyed variables, rather than some under another key first.
 */
export function variableDeviceKey(
	self: DanteInstance,
	device: { id?: DanteDeviceId; name?: DeviceName },
): string | undefined {
	if (variableKeysOf(self.config) === 'names') return device.name ? sanitiseVariableId(device.name) : undefined
	return device.id
}

/**
 * Definitions for the routing variables, built from the same device set the per-device action
 * fields are (live devices plus ones whose channels are remembered), so a device that blips keeps
 * its variables and their last values.
 *
 * Definition names carry the device name but never a channel name: a channel rename then changes
 * one value, instead of re-sending every definition on the network.
 */
function addRoutingDefinitions(
	self: DanteInstance,
	variables: CompanionVariableDefinitions<DanteVariableValues>,
): void {
	for (const { id: deviceId, name } of channelFieldDevices(self)) {
		const id = variableDeviceKey(self, { id: deviceId, name })
		if (id === undefined) continue
		variables[`${id}_device_id`] = { name: `Dante device id of ${name}` }
		variables[`${id}_device_name`] = { name: `Dante device name of ${name}` }

		for (const choice of self.rxChannelsChoices[deviceId] ?? []) {
			variables[`${id}_rx_${choice.id}_name`] = { name: `${name} audio receive channel ${choice.id} name` }
			variables[`${id}_rx_${choice.id}_source`] = { name: `${name} audio receive channel ${choice.id} source` }
			variables[`${id}_rx_${choice.id}_source_id`] = {
				name: `${name} audio receive channel ${choice.id} source id`,
			}
		}
		for (const choice of self.txChannelsChoices[deviceId] ?? []) {
			variables[`${id}_tx_${choice.id}_name`] = { name: `${name} audio transmit channel ${choice.id} name` }
		}
		for (const choice of self.videoRxChannelsChoices?.[deviceId] ?? []) {
			variables[`${id}_rx_video_${choice.id}_name`] = { name: `${name} video receive channel ${choice.id} name` }
			variables[`${id}_rx_video_${choice.id}_source`] = {
				name: `${name} video receive channel ${choice.id} source`,
			}
			variables[`${id}_rx_video_${choice.id}_source_id`] = {
				name: `${name} video receive channel ${choice.id} source id`,
			}
		}
		for (const choice of self.videoTxChannelsChoices?.[deviceId] ?? []) {
			variables[`${id}_tx_video_${choice.id}_name`] = { name: `${name} video transmit channel ${choice.id} name` }
		}
	}
}

/** Definitions for the per-device property variables. */
function addDevicePropertyDefinitions(
	self: DanteInstance,
	variables: CompanionVariableDefinitions<DanteVariableValues>,
): void {
	for (const [, device] of brandedEntries(self.devicesData)) {
		const id = variableDeviceKey(self, device)
		if (!device.name || id === undefined) continue
		variables[`${id}_ip`] = { name: 'Ip address of ' + device.name }
		variables[`${id}_locked`] = { name: 'Device lock state of ' + device.name }
		variables[`${id}_tx`] = { name: 'Number of audio outputs for ' + device.name }
		variables[`${id}_tx_names`] = { name: 'Audio output names for ' + device.name }
		variables[`${id}_rx`] = { name: 'Number of audio inputs for ' + device.name }
		variables[`${id}_rx_names`] = { name: 'Audio input names for ' + device.name }
		variables[`${id}_tx_video`] = { name: 'Number of video outputs for ' + device.name }
		variables[`${id}_tx_names_video`] = { name: 'Video output names for ' + device.name }
		variables[`${id}_rx_video`] = { name: 'Number of video inputs for ' + device.name }
		variables[`${id}_rx_names_video`] = { name: 'Video input names for ' + device.name }
		variables[`${id}_sr`] = { name: 'Sample rate of ' + device.name }
		variables[`${id}_pullup`] = { name: 'Sample rate pullup of ' + device.name }
		variables[`${id}_latency`] = { name: 'Latency of ' + device.name + ' (in ms)' }
		variables[`${id}_encoding`] = { name: 'Encoding of ' + device.name }
		variables[`${id}_output_levels`] = { name: 'Output levels of ' + device.name }
		variables[`${id}_model_name`] = { name: 'Model name of ' + device.name }
		variables[`${id}_product_version`] = { name: 'Product version of ' + device.name }
		variables[`${id}_dante_model`] = { name: 'Dante model of ' + device.name }
		variables[`${id}_dante_software_version`] = { name: 'Dante software version of ' + device.name }
		variables[`${id}_hardware_version`] = { name: 'Hardware version of ' + device.name }
		variables[`${id}_manufacturer`] = { name: 'Manufacturer of ' + device.name }
		variables[`${id}_manufacturer_short`] = { name: 'Manufacturer (short) of ' + device.name }
		variables[`${id}_software_version`] = { name: 'Software version of ' + device.name }
		variables[`${id}_software_build`] = { name: 'Software build of ' + device.name }
		variables[`${id}_dante_software_build`] = { name: 'Dante software build of ' + device.name }
		variables[`${id}_hardware_build`] = { name: 'Hardware build of ' + device.name }
	}
}

/**
 * Every variable category `CheckVariables` knows how to refresh, used when no explicit set is given.
 *
 * `pullup` was missing here despite having both a definition and a case below, so a full sweep
 * never refreshed `<device>_pullup` - it only ever updated when a settings reply happened to pass
 * 'pullup' explicitly.
 */
export const ALL_VARIABLE_TYPES = [
	'ip',
	'locked',
	'rx',
	'tx',
	'rx_names',
	'tx_names',
	'rx_video',
	'tx_video',
	'rx_names_video',
	'tx_names_video',
	'sr',
	'latency',
	'encoding',
	'pullup',
	'output_levels',
	'manf',
	'versions',
	'device_id',
] as const

/**
 * The categories whose replies can change a routing variable. A request for any of them refreshes
 * the device's routing values; the publisher then sends only the ones that differ.
 */
const ROUTING_TYPES = new Set<string>([
	'rx',
	'tx',
	'rx_names',
	'tx_names',
	'rx_video',
	'tx_video',
	'rx_names_video',
	'tx_names_video',
	'device_id',
])

/** The categories of one device that can change another device's source ids. */
const SOURCE_ID_TYPES = new Set<string>(['tx', 'tx_names', 'tx_video', 'tx_names_video', 'device_id'])

/**
 * Recomputes and pushes current variable values to Companion.
 * @param ipAddress If given, restricts the update to the device at this IP; otherwise all known devices are updated.
 * @param variableTypes Which variable categories to refresh; defaults to all categories if none are given.
 */
export function CheckVariables(self: DanteInstance, ipAddress?: DeviceIp, ...variableTypes: string[]): void {
	const variableValues: Partial<DanteVariableValues> = {}

	if (
		routingVariablesEnabled(self.config) &&
		(variableTypes.length === 0 || variableTypes.some((type) => ROUTING_TYPES.has(type)))
	) {
		// A source id names the transmitting device, so a change to one device's transmit channels or
		// id can change other devices' values - those are re-resolved everywhere, and the publisher
		// sends only the ones that moved.
		const resolveEverywhere =
			ipAddress === undefined || variableTypes.length === 0 || variableTypes.some((type) => SOURCE_ID_TYPES.has(type))
		for (const [ip, device] of brandedEntries(self.devicesData)) {
			if (ipAddress === undefined || ip === ipAddress) addRoutingValues(self, ip, device, variableValues)
			else if (resolveEverywhere) addSourceIdValues(self, ip, device, variableValues)
		}
	}

	// Device properties are still tracked when their variables are off; the Device Property
	// feedback reads them through the same accessor either way.
	if (self.config.variables) addDevicePropertyValues(self, variableValues, ipAddress, variableTypes)

	try {
		variablePublisher(self).setValues(variableValues)
	} catch (error) {
		logger.error('Error setting variables: ' + error)
	}
}

/** A subscription as the routing variables show it: `channel@device`, Dante's own notation. */
function subscriptionValue(source: { channelName: string; deviceName: string } | undefined): string {
	return source ? `${source.channelName}@${source.deviceName}` : ''
}

/** One device's routing values. See `DanteRoutingVariables`. */
function addRoutingValues(
	self: DanteInstance,
	ip: DeviceIp,
	device: DeviceData,
	variableValues: Partial<DanteVariableValues>,
): void {
	const id = variableDeviceKey(self, device)
	if (!device.name || id === undefined) return

	variableValues[`${id}_device_id`] = device.id ?? ''
	variableValues[`${id}_device_name`] = device.name

	for (const channel of channelNumbers(device.audioRx?.count)) {
		variableValues[`${id}_rx_${channel}_name`] = device.audioRx?.[channel]?.name ?? ''
		variableValues[`${id}_rx_${channel}_source`] = subscriptionValue(getAudioRxChannelSource(self, ip, channel))
	}
	addSourceIdValues(self, ip, device, variableValues)
	for (const channel of channelNumbers(device.audioTx?.count)) {
		variableValues[`${id}_tx_${channel}_name`] = getChannelSubscriptionName(device.audioTx?.[channel]) ?? ''
	}
	for (const channel of channelNumbers(device.videoRx?.count)) {
		variableValues[`${id}_rx_video_${channel}_name`] = device.videoRx?.[channel]?.name ?? ''
		variableValues[`${id}_rx_video_${channel}_source`] = subscriptionValue(getVideoRxChannelSource(self, ip, channel))
	}
	for (const channel of channelNumbers(device.videoTx?.count)) {
		variableValues[`${id}_tx_video_${channel}_name`] = device.videoTx?.[channel]?.name ?? ''
	}
}

/** One device's `_source_id` values. See `resolveSubscriptionSource`. */
function addSourceIdValues(
	self: DanteInstance,
	ip: DeviceIp,
	device: DeviceData,
	variableValues: Partial<DanteVariableValues>,
): void {
	const id = variableDeviceKey(self, device)
	if (id === undefined) return
	const resolve = (source: { deviceName: string; channelName: string } | undefined, mediaType: 'audio' | 'video') =>
		source ? (resolveSubscriptionSource(self, source, mediaType) ?? '') : ''

	for (const channel of channelNumbers(device.audioRx?.count)) {
		variableValues[`${id}_rx_${channel}_source_id`] = resolve(getAudioRxChannelSource(self, ip, channel), 'audio')
	}
	for (const channel of channelNumbers(device.videoRx?.count)) {
		variableValues[`${id}_rx_video_${channel}_source_id`] = resolve(getVideoRxChannelSource(self, ip, channel), 'video')
	}
}

/** The per-device property values, plus the `devices` list. */
function addDevicePropertyValues(
	self: DanteInstance,
	variableValues: Partial<DanteVariableValues>,
	ipAddress: DeviceIp | undefined,
	variableTypes: string[],
): void {
	if (!(variableTypes.length > 0)) {
		variableTypes = [...ALL_VARIABLE_TYPES]
	}

	const devices: string[] = []

	for (const [ip, device] of brandedEntries(self.devicesData)) {
		const deviceName = device.name
		if (deviceName) {
			devices.push(deviceName)
			// must match the ids UpdateVariableDefinitions registered
			const id = variableDeviceKey(self, device)

			if (id !== undefined && (ip == ipAddress || !ipAddress)) {
				for (const variableType of variableTypes) {
					switch (variableType) {
						case 'devices':
							break

						// Values come from `deviceProperty`, the same accessor the Device Property feedback
						// reads, so a variable and a feedback can never disagree about a device.
						case 'ip':
							variableValues[`${id}_ip`] = deviceProperty(device, ip, 'ip')
							break

						case 'locked':
							variableValues[`${id}_locked`] = deviceProperty(device, ip, 'locked')
							break

						case 'rx':
						case 'tx':
							variableValues[`${id}_${variableType}`] = deviceProperty(device, ip, variableType)
							break

						case 'rx_names':
						case 'tx_names':
							variableValues[`${id}_${variableType}`] = deviceProperty(device, ip, variableType)
							break

						case 'rx_video':
						case 'tx_video':
							variableValues[`${id}_${variableType}`] = deviceProperty(device, ip, variableType)
							break

						case 'rx_names_video':
						case 'tx_names_video':
							variableValues[`${id}_${variableType}`] = deviceProperty(device, ip, variableType)
							break

						// Split rather than grouped: each of these has its own value type in the schema, so a
						// single indexed write would be checked against the union of them all.
						case 'sr':
							variableValues[`${id}_sr`] = deviceProperty(device, ip, 'sr')
							break

						case 'latency':
							variableValues[`${id}_latency`] = deviceProperty(device, ip, 'latency')
							break

						case 'encoding':
							variableValues[`${id}_encoding`] = deviceProperty(device, ip, 'encoding')
							break

						case 'pullup':
							variableValues[`${id}_pullup`] = deviceProperty(device, ip, 'pullup')
							break

						case 'output_levels':
							variableValues[`${id}_output_levels`] = deviceProperty(device, ip, 'output_levels')
							break

						// one update category, two variables
						case 'manf':
							variableValues[`${id}_model_name`] = deviceProperty(device, ip, 'model_name')
							variableValues[`${id}_product_version`] = deviceProperty(device, ip, 'product_version')
							variableValues[`${id}_manufacturer`] = deviceProperty(device, ip, 'manufacturer')
							variableValues[`${id}_manufacturer_short`] = deviceProperty(device, ip, 'manufacturer_short')
							variableValues[`${id}_software_version`] = deviceProperty(device, ip, 'software_version')
							variableValues[`${id}_software_build`] = deviceProperty(device, ip, 'software_build')
							break

						// the versions reply, likewise
						case 'versions':
							variableValues[`${id}_dante_model`] = deviceProperty(device, ip, 'dante_model')
							variableValues[`${id}_dante_software_version`] = deviceProperty(device, ip, 'dante_software_version')
							variableValues[`${id}_hardware_version`] = deviceProperty(device, ip, 'hardware_version')
							variableValues[`${id}_dante_software_build`] = deviceProperty(device, ip, 'dante_software_build')
							variableValues[`${id}_hardware_build`] = deviceProperty(device, ip, 'hardware_build')
							break
					}
				}
			}
		}
	}

	variableValues.devices = devices
}
