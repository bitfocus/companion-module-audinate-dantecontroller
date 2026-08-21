import {
	combineRgb,
	Regex,
	type CompanionBooleanFeedbackDefinition,
	type CompanionFeedbackDefinitions,
	type SomeCompanionFeedbackInputField,
} from '@companion-module/base'
import {
	findTxChannelByName,
	findRxChannelByName,
	findDeviceIpByName,
	getChannelSubscriptionName,
	hasRxChannels,
	hasTxChannels,
	trackFeedbackDevices,
	untrackFeedback,
} from './api.js'
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

export type FeedbackSchema = {
	routing_bg: { type: 'boolean'; options: RoutingBgOptions }
	routing_bg_manual: { type: 'boolean'; options: RoutingBgManualOptions }
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
		name: 'Crosspoint Connected',
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
				choices: self.devicesChoices.filter((choice) => hasRxChannels(self.devicesData[choice.id])),
				default: self.devicesChoices[0]?.id ?? '',
				disableAutoExpression: true,
			},
			...Object.entries(self.devicesData)
				.filter(([, device]) => hasRxChannels(device))
				.map(([ip, device]): SomeCompanionFeedbackInputField<keyof RoutingBgOptions> => ({
					type: 'dropdown',
					label: 'Destination channel',
					id: `destinationChannel_${ip}`,
					choices: device.name ? (self.rxChannelsChoices[device.name] ?? []) : [],
					default: 0,
					isVisibleExpression: `$(options:destinationDevice) == '${ip}'`,
				})),
			{
				type: 'dropdown',
				label: 'Source Device',
				id: 'sourceDevice',
				choices: self.devicesChoices.filter((choice) => hasTxChannels(self.devicesData[choice.id])),
				default: self.devicesChoices[0]?.id ?? '',
				disableAutoExpression: true,
			},
			...Object.entries(self.devicesData)
				.filter(([, device]) => hasTxChannels(device))
				.map(([ip, device]): SomeCompanionFeedbackInputField<keyof RoutingBgOptions> => ({
					type: 'dropdown',
					label: 'Source channel',
					id: `sourceChannel_${ip}`,
					choices: device.name ? (self.txChannelsChoices[device.name] ?? []) : [],
					default: 0,
					isVisibleExpression: `$(options:sourceDevice) == '${ip}'`,
				})),
		],
		unsubscribe: (feedback) => untrackFeedback(self, feedback.id),
		callback: (feedback) => {
			const opt = feedback.options
			// Both dropdown ids are device IPs, so this instance's dependencies are known exactly.
			trackFeedbackDevices(self, feedback.id, [opt.destinationDevice, opt.sourceDevice])
			if (opt.destinationDevice && self.devicesData[opt.destinationDevice]?.rx && opt.sourceDevice) {
				const destinationChannel =
					self.devicesData[opt.destinationDevice].rx?.[opt[`destinationChannel_${opt.destinationDevice}`]]
				const selectedSourceChannel = opt[`sourceChannel_${opt.sourceDevice}`]
				const sourceChannel =
					self.devicesData[opt.sourceDevice]?.tx?.[selectedSourceChannel] ??
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
				const selectedSourceDeviceName = normalizeName(self.devicesData[opt.sourceDevice]?.name)
				const sourceDeviceMatches =
					destinationSourceDeviceName == selectedSourceDeviceName ||
					(destinationSourceDeviceName == '.' && opt.destinationDevice == opt.sourceDevice)
				const subscriptionOk =
					destinationChannel?.subscriptionStatus !== undefined &&
					[9, 10, 14].includes(destinationChannel.subscriptionStatus)
				return sourceDeviceMatches && sourceChannelMatches && subscriptionOk
			}
			return false
		},
	}

	const routingBgManual: CompanionBooleanFeedbackDefinition<RoutingBgManualOptions> = {
		type: 'boolean',
		name: 'Crosspoint Connected (manual)',
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
				const subscriptionOk =
					destinationChannel?.subscriptionStatus !== undefined &&
					[9, 10, 14].includes(destinationChannel.subscriptionStatus)
				return sourceDeviceMatches && sourceChannelMatches && subscriptionOk
			}
			return false
		},
	}

	const feedbacks: CompanionFeedbackDefinitions<FeedbackSchema> = {
		routing_bg: routingBg,
		routing_bg_manual: routingBgManual,
	}

	self.setFeedbackDefinitions(feedbacks)
}
