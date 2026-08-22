import {
	combineRgb,
	Regex,
	type CompanionBooleanFeedbackDefinition,
	type CompanionFeedbackDefinitions,
	type CompanionValueFeedbackDefinition,
	type SomeCompanionFeedbackInputField,
} from '@companion-module/base'
import {
	channelChoices,
	channelRangeDescription,
	deviceByIdentifier,
	deviceOptionValue,
	deviceSelectedExpression,
	findDeviceIpByName,
	findRxChannelByName,
	findTxChannelByName,
	firstChoiceId,
	getChannelSubscriptionName,
	getRxChannelSource,
	isSubscriptionConnected,
	DEVICE_PROPERTIES,
	DEVICE_PROPERTY_LABELS,
	deviceProperty,
	orPlaceholder,
	type DeviceProperty,
	resolveDeviceIp,
	rxDeviceChoices,
	trackFeedbackDevices,
	txDeviceChoices,
	untrackFeedback,
} from './api/index.js'
import type DanteInstance from './main.js'

type RoutingBgOptions = {
	destinationDevice: string
	sourceDevice: string
} & Record<`destinationChannel_${string}`, number> &
	Record<`sourceChannel_${string}`, number>

type RoutingBgManualOptions = {
	sourceChannelName: string
	sourceDeviceName: string
	destinationChannelId: string
	destinationDeviceId: string
}

type DevicePropertyOptions = {
	device: string
	property: string
}

type ChannelSubscriptionOptions = {
	device: string
} & Record<`channel_${string}`, number>

/**
 * What a receive channel is subscribed to.
 *
 * Always this shape, even when nothing is subscribed - a layout reading `channel.number` should not
 * have to guard against the whole object being absent. An empty subscription reports empty strings
 * and channel 0, which is not a valid Dante channel number.
 */
interface ChannelSubscriptionValue {
	/**
	 * True only when the subscription is carrying audio.
	 *
	 * False both when nothing is subscribed and when a subscription exists but is not working -
	 * the source device offline, for instance.
	 */
	connected: boolean
	device: { name: string; ip: string }
	channel: { name: string; number: number }
}

const NO_SUBSCRIPTION = {
	connected: false,
	device: { name: '', ip: '' },
	channel: { name: '', number: 0 },
} as const satisfies ChannelSubscriptionValue

export type FeedbackSchema = {
	routing_bg: { type: 'boolean'; options: RoutingBgOptions }
	routing_bg_manual: { type: 'boolean'; options: RoutingBgManualOptions }
	device_property: { type: 'value'; options: DevicePropertyOptions }
	channel_subscription: { type: 'value'; options: ChannelSubscriptionOptions }
}

/** True if a stored option value names a property this module knows. */
function isDeviceProperty(value: string): value is DeviceProperty {
	return (DEVICE_PROPERTIES as readonly string[]).includes(value)
}

function normalizeName(name: string | number | undefined | null): string {
	return String(name ?? '')
		.trim()
		.toLowerCase()
}

/**
 * Builds and registers this instance's feedback definitions, including one
 * per-device dropdown option (and its visibility expression) for each known Dante device.
 */
export function UpdateFeedbacks(self: DanteInstance): void {
	// const foregroundColor = combineRgb(255, 255, 255) // White
	// const backgroundColorRed = combineRgb(255, 0, 0) // Red

	const routingBg: CompanionBooleanFeedbackDefinition<RoutingBgOptions> = {
		type: 'boolean',
		name: 'Crosspoint - Connected',
		description: 'True If the specified source channel specified is routed to the correct output',
		defaultStyle: {
			color: combineRgb(0, 0, 0),
			bgcolor: combineRgb(255, 255, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Destination Device',
				id: 'destinationDevice',
				choices: rxDeviceChoices(self),
				default: firstChoiceId(rxDeviceChoices(self), ''),
				disableAutoExpression: true,
				// see actions.ts: a legacy address must remain a selectable value
				allowCustom: true,
			},
			...Object.entries(self.devicesData)
				.filter(([, device]) => channelChoices(self, device, 'rx').length > 0)
				.map(([ip, device]): SomeCompanionFeedbackInputField<keyof RoutingBgOptions> => ({
					type: 'dropdown',
					label: 'Destination channel',
					id: `destinationChannel_${device.name}`,
					choices: channelChoices(self, device, 'rx'),
					default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
					expressionDescription: channelRangeDescription(channelChoices(self, device, 'rx'), device.name ?? ''),
					// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
					// allowCustom keeps actions still holding it parseable rather than failing outright
					allowCustom: true,
					isVisibleExpression: deviceSelectedExpression('destinationDevice', device.name ?? '', ip),
				})),
			{
				type: 'dropdown',
				label: 'Source Device',
				id: 'sourceDevice',
				choices: txDeviceChoices(self),
				default: firstChoiceId(txDeviceChoices(self), ''),
				disableAutoExpression: true,
				// see actions.ts: a legacy address must remain a selectable value
				allowCustom: true,
			},
			...Object.entries(self.devicesData)
				.filter(([, device]) => channelChoices(self, device, 'tx').length > 0)
				.map(([ip, device]): SomeCompanionFeedbackInputField<keyof RoutingBgOptions> => ({
					type: 'dropdown',
					label: 'Source channel',
					id: `sourceChannel_${device.name}`,
					choices: channelChoices(self, device, 'tx'),
					default: firstChoiceId(channelChoices(self, device, 'tx'), 0),
					expressionDescription: channelRangeDescription(channelChoices(self, device, 'tx'), device.name ?? ''),
					// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
					// allowCustom keeps actions still holding it parseable rather than failing outright
					allowCustom: true,
					isVisibleExpression: deviceSelectedExpression('sourceDevice', device.name ?? '', ip),
				})),
		],
		unsubscribe: (feedback) => untrackFeedback(self, feedback.id),
		callback: (feedback) => {
			const opt = feedback.options
			// Both dropdown ids are device IPs, so this instance's dependencies are known exactly.
			trackFeedbackDevices(self, feedback.id, [
				resolveDeviceIp(self, opt.destinationDevice),
				resolveDeviceIp(self, opt.sourceDevice),
			])
			// Pickers store the device name; actions saved before that store an address. Both resolve.
			const destinationDevice = deviceByIdentifier(self, opt.destinationDevice)
			const sourceDevice = deviceByIdentifier(self, opt.sourceDevice)
			if (opt.destinationDevice && destinationDevice?.rx && opt.sourceDevice) {
				const destinationChannel =
					destinationDevice.rx?.[deviceOptionValue<number>(self, opt, 'destinationChannel', opt.destinationDevice, 0)]
				const selectedSourceChannel = deviceOptionValue<number>(self, opt, 'sourceChannel', opt.sourceDevice, 0)
				const sourceChannel =
					sourceDevice?.tx?.[selectedSourceChannel] ??
					findTxChannelByName(self, opt.sourceDevice, String(selectedSourceChannel))
				const destinationSourceChannelName = normalizeName(destinationChannel?.sourceChannel)
				const sourceChannelCandidates = [
					selectedSourceChannel,
					getChannelSubscriptionName(sourceChannel),
					sourceChannel?.name,
					sourceChannel?.friendlyName,
				]
					.filter(Boolean)
					.map((name) => normalizeName(name))
				if (sourceChannel?.number != undefined) {
					const number = sourceChannel.number
					if (!isNaN(number)) {
						sourceChannelCandidates.push(String(number), String(number).padStart(2, '0'))
					}
				}
				const sourceChannelMatches = sourceChannelCandidates.includes(destinationSourceChannelName)
				const destinationSourceDeviceName = normalizeName(destinationChannel?.sourceDevice)
				const selectedSourceDeviceName = normalizeName(sourceDevice?.name)
				const sourceDeviceMatches =
					destinationSourceDeviceName == selectedSourceDeviceName ||
					(destinationSourceDeviceName == '.' && opt.destinationDevice == opt.sourceDevice)
				const subscriptionOk = isSubscriptionConnected(destinationChannel?.subscriptionStatus)
				return sourceDeviceMatches && sourceChannelMatches && subscriptionOk
			}
			return false
		},
	}

	const routingBgManual: CompanionBooleanFeedbackDefinition<RoutingBgManualOptions> = {
		type: 'boolean',
		name: 'Crosspoint - Connected (manual)',
		description: 'True if the specified source channel specified is routed to the correct output',
		defaultStyle: {
			color: combineRgb(0, 0, 0),
			bgcolor: combineRgb(255, 255, 0),
		},
		options: [
			{
				type: 'textinput',
				label: 'Source Channel Name',
				id: 'sourceChannelName',
				default: 'Input 1',
				useVariables: true,
			},
			{
				type: 'textinput',
				label: 'Source Device Name',
				id: 'sourceDeviceName',
				default: 'MyDanteDeviceName',
				useVariables: true,
			},
			{
				type: 'textinput',
				label: 'Destination Channel',
				tooltip: 'Enter either channel name or channel number',
				id: 'destinationChannelId',
				default: '1',
				useVariables: true,
			},
			{
				type: 'textinput',
				label: 'Destination Device',
				tooltip: 'Enter either device name or device IP',
				id: 'destinationDeviceId',
				default: 'MyDanteDevice',
				useVariables: true,
			},
		],
		unsubscribe: (feedback) => untrackFeedback(self, feedback.id),
		callback: async (feedback) => {
			const opt = feedback.options
			const sourceChannelName = opt.sourceChannelName
			const sourceDeviceName = opt.sourceDeviceName
			const destinationChannelId = opt.destinationChannelId
			const destinationDeviceId = opt.destinationDeviceId

			// Check if destinationDeviceId is an IP or a name
			const IP = RegExp(Regex.IP.slice(1, -1))
			const destinationDeviceIp = IP.test(destinationDeviceId)
				? destinationDeviceId
				: findDeviceIpByName(self, destinationDeviceId)

			// These options are free text (and may come from variables), so either device may fail to
			// resolve - against a device that has not been discovered yet, for instance. An unresolved
			// entry registers this feedback as a wildcard so it keeps being checked regardless.
			trackFeedbackDevices(self, feedback.id, [destinationDeviceIp, findDeviceIpByName(self, sourceDeviceName)])

			if (destinationDeviceIp && sourceDeviceName && self.devicesData[destinationDeviceIp]?.rx) {
				const destinationChannel =
					findRxChannelByName(self, destinationDeviceIp, destinationChannelId) ??
					self.devicesData[destinationDeviceIp].rx?.[Number(destinationChannelId)]
				if (destinationChannel == undefined) {
					return false
				}

				const sourceChannel = findTxChannelByName(self, sourceDeviceName, sourceChannelName)
				const destinationSourceChannelName = normalizeName(destinationChannel?.sourceChannel)
				const sourceChannelCandidates = [
					sourceChannelName,
					getChannelSubscriptionName(sourceChannel),
					sourceChannel?.name,
					sourceChannel?.friendlyName,
				]
					.filter(Boolean)
					.map((name) => normalizeName(name))
				if (sourceChannel?.number != undefined) {
					const number = sourceChannel.number
					if (!isNaN(number)) {
						sourceChannelCandidates.push(String(number), String(number).padStart(2, '0'))
					}
				}

				const sourceChannelMatches = sourceChannelCandidates.includes(destinationSourceChannelName)
				const destinationSourceDeviceName = normalizeName(destinationChannel?.sourceDevice)
				const selectedSourceDeviceName = normalizeName(sourceDeviceName)
				const sourceDeviceMatches =
					destinationSourceDeviceName == selectedSourceDeviceName ||
					(destinationSourceDeviceName == '.' && self.devicesData[destinationDeviceIp].name == sourceDeviceName)
				const subscriptionOk = isSubscriptionConnected(destinationChannel?.subscriptionStatus)
				return sourceDeviceMatches && sourceChannelMatches && subscriptionOk
			}
			return false
		},
	}

	const deviceProperties = orPlaceholder(self.devicesChoices, 'No devices found')
	const devicePropertyFeedback: CompanionValueFeedbackDefinition<DevicePropertyOptions> = {
		type: 'value',
		name: 'Device - Property',
		description: 'The current value of one device property, the same value its module variable holds.',
		options: [
			{
				type: 'dropdown',
				label: 'Device',
				id: 'device',
				choices: deviceProperties,
				default: firstChoiceId(deviceProperties, ''),
				// as elsewhere: a device saved by address rather than by name must stay selectable
				allowCustom: true,
			},
			{
				type: 'dropdown',
				label: 'Property',
				id: 'property',
				choices: DEVICE_PROPERTIES.map((property) => ({ id: property, label: DEVICE_PROPERTY_LABELS[property] })),
				// named rather than taken from the list, which is ordered alphabetically for the picker -
				// its first entry is not a sensible default
				default: 'ip',
				// In expression mode the picker is gone, so the accepted values have to be written out.
				// Generated from the same list the choices are, so it cannot fall out of step.
				expressionDescription: `Must evaluate to one of: ${DEVICE_PROPERTIES.join(', ')}`,
			},
		],
		unsubscribe: (feedback) => untrackFeedback(self, feedback.id),
		callback: (feedback) => {
			const opt = feedback.options
			// Record which device this reads, so a change to it re-checks this feedback by id rather
			// than re-evaluating every feedback of this type.
			const ip = resolveDeviceIp(self, opt.device)
			trackFeedbackDevices(self, feedback.id, [ip])

			const device = ip !== undefined ? self.devicesData[ip] : undefined
			if (ip === undefined || !device || !isDeviceProperty(opt.property)) {
				// unknown device or a property this build does not have - report nothing rather than
				// something misleading
				return ''
			}

			return deviceProperty(device, ip, opt.property) ?? ''
		},
	}

	const channelSubscription: CompanionValueFeedbackDefinition<ChannelSubscriptionOptions> = {
		type: 'value',
		name: 'Channel - Subscription',
		description: 'Returns the channel a destination is subscribed to',
		options: [
			{
				type: 'dropdown',
				label: 'Device',
				id: 'device',
				choices: rxDeviceChoices(self),
				default: firstChoiceId(rxDeviceChoices(self), ''),
				disableAutoExpression: true,
				// see actions.ts: a legacy address must remain a selectable value
				allowCustom: true,
			},
			...Object.entries(self.devicesData)
				.filter(([, device]) => channelChoices(self, device, 'rx').length > 0)
				.map(([ip, device]): SomeCompanionFeedbackInputField<keyof ChannelSubscriptionOptions> => ({
					type: 'dropdown',
					label: 'Channel',
					id: `channel_${device.name}`,
					choices: channelChoices(self, device, 'rx'),
					default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
					expressionDescription: channelRangeDescription(channelChoices(self, device, 'rx'), device.name ?? ''),
					allowCustom: true,
					isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
				})),
		],
		unsubscribe: (feedback) => untrackFeedback(self, feedback.id),
		callback: (feedback) => {
			const opt = feedback.options
			const channelNumber = deviceOptionValue<number>(self, opt, 'channel', opt.device, 0)
			const source = getRxChannelSource(self, opt.device, channelNumber)

			// Depends on the destination (which reports the subscription) and on the source (whose
			// transmit channels give the number), so a change to either must re-check this feedback -
			// the same pair the Crosspoint Connected feedback tracks.
			trackFeedbackDevices(
				self,
				feedback.id,
				// With no subscription there is no source to depend on, so the destination alone decides
				// this value. Passing an undefined source instead would register the feedback as a
				// wildcard and have every device's traffic re-check it.
				source
					? [resolveDeviceIp(self, opt.device), resolveDeviceIp(self, source.deviceName)]
					: [resolveDeviceIp(self, opt.device)],
			)

			if (!source) {
				return { ...NO_SUBSCRIPTION }
			}

			// The name is the one the destination reports, which is the subscription as it stands - a
			// source renamed since it was made still reports the name the subscription was built with.
			const sourceChannel = findTxChannelByName(self, source.deviceName, source.channelName)
			return {
				connected: source.connected,
				device: { name: source.deviceName, ip: resolveDeviceIp(self, source.deviceName) ?? '' },
				channel: { name: source.channelName, number: sourceChannel?.number ?? 0 },
			}
		},
	}

	const feedbacks: CompanionFeedbackDefinitions<FeedbackSchema> = {
		routing_bg: routingBg,
		routing_bg_manual: routingBgManual,
		device_property: devicePropertyFeedback,
		channel_subscription: channelSubscription,
	}

	self.setFeedbackDefinitions(feedbacks)
}
