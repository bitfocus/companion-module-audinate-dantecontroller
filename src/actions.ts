import type { CompanionActionDefinitions, SomeCompanionActionInputField } from '@companion-module/base'
import { DANTE_CONST, object2choices, object2PartialChoices, array2choices } from './const.js'
import {
	makeCrosspoint,
	clearCrosspoint,
	clearAllCrosspoints,
	setDeviceName,
	resetDeviceName,
	setRxChannelName,
	resetRxChannelName,
	setTxChannelName,
	resetTxChannelName,
	setLatency,
	setSampleRate,
	setPullup,
	setEncoding,
	setLevel,
	refreshSettings,
	refreshArc,
	findTxChannelByName,
	getChannelSubscriptionName,
	hasRxChannels,
	hasTxChannels,
} from './api.js'
import type DanteInstance from './main.js'

type MakeCrosspointOptions = {
	sourceChannelName: string
	sourceDeviceName: string
	destinationChannelNumber: string
	destinationDeviceAddress: string
}

type MakeCrosspointDropDownOptions = {
	destinationDevice: string
	sourceDevice: string
} & Record<`destinationChannel_${string}`, number> &
	Record<`sourceChannel_${string}`, number>

type ClearCrosspointOptions = {
	destinationChannelNumber: string
	destinationDeviceAdddress: string
	clearAll: boolean
}

type ClearCrosspointDropDownOptions = {
	destinationDevice: string
	clearAll: boolean
} & Record<`destinationChannel_${string}`, number>

type SetDeviceNameOptions = {
	device: string
	name: string
}

type ResetDeviceNameOptions = {
	device: string
}

type SetChannelNameOptions = {
	device: string
	newName: string
} & Record<`channel_${string}`, number>

type ResetChannelNameOptions = {
	device: string
} & Record<`channel_${string}`, number>

type SetLatencyOptions = {
	destinationDevice: string
	latency: number
}

type SetSampleRateCustomOptions = {
	device: string
	sr: number
}

type SetSampleRateOptions = {
	device: string
} & Record<`sr_${string}`, number>

type SetPullupOptions = {
	device: string
} & Record<`pullup_${string}`, number>

type SetEncodingOptions = {
	device: string
} & Record<`encoding_${string}`, number>

type SetOutputLevelOptions = {
	device: string
	level: number
} & Record<`channel_${string}`, number>

export type ActionSchema = {
	makeCrosspoint: { options: MakeCrosspointOptions }
	makeCrosspointDropDown: { options: MakeCrosspointDropDownOptions }
	clearCrosspoint: { options: ClearCrosspointOptions }
	clearCrosspointDropDown: { options: ClearCrosspointDropDownOptions }
	setDeviceName: { options: SetDeviceNameOptions }
	setDeviceNameCustom: { options: SetDeviceNameOptions }
	resetDeviceName: { options: ResetDeviceNameOptions }
	setRxChannelName: { options: SetChannelNameOptions }
	resetRxChannelName: { options: ResetChannelNameOptions }
	setTxChannelName: { options: SetChannelNameOptions }
	resetTxChannelName: { options: ResetChannelNameOptions }
	setLatency: { options: SetLatencyOptions }
	setSampleRateCustom: { options: SetSampleRateCustomOptions }
	setSampleRate: { options: SetSampleRateOptions }
	setPullup: { options: SetPullupOptions }
	setEncoding: { options: SetEncodingOptions }
	setOutputLevel: { options: SetOutputLevelOptions }
	refresh: { options: Record<string, never> }
}

/**
 * Builds and registers this instance's action definitions, including one
 * per-device dropdown option (and its visibility expression) for each known Dante device.
 */
export function UpdateActions(self: DanteInstance): void {
	const actions: CompanionActionDefinitions<ActionSchema> = {
		makeCrosspoint: {
			name: 'Make Crosspoint',
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
					id: 'destinationChannelNumber',
					default: '1',
					useVariables: true,
				},
				{
					type: 'textinput',
					label: 'Destination Device',
					tooltip: 'Enter either device name or device IP',
					id: 'destinationDeviceAddress',
					default: 'MyDanteDevice',
					useVariables: true,
				},
			],
			callback: async (action) => {
				const opt = action.options
				makeCrosspoint(
					self,
					opt.destinationDeviceAddress,
					opt.sourceChannelName,
					opt.sourceDeviceName,
					opt.destinationChannelNumber,
				)
			},
		},

		makeCrosspointDropDown: {
			name: 'Make Crosspoint (drop down menu)',
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
					.map(([ip, device]): SomeCompanionActionInputField<keyof MakeCrosspointDropDownOptions> => ({
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
					.map(([ip, device]): SomeCompanionActionInputField<keyof MakeCrosspointDropDownOptions> => ({
						type: 'dropdown',
						label: 'Source channel',
						id: `sourceChannel_${ip}`,
						choices: device.name ? (self.txChannelsChoices[device.name] ?? []) : [],
						default: 0,
						isVisibleExpression: `$(options:sourceDevice) == '${ip}'`,
					})),
			],
			callback: async (action) => {
				const opt = action.options
				const sourceChannelNumber = opt[`sourceChannel_${opt.sourceDevice}`]
				const sourceChannel =
					self.devicesData[opt.sourceDevice]?.tx?.[sourceChannelNumber] ??
					findTxChannelByName(self, opt.sourceDevice, String(sourceChannelNumber))
				const sourceChannelName = getChannelSubscriptionName(sourceChannel) || String(sourceChannelNumber)
				makeCrosspoint(
					self,
					opt.destinationDevice,
					sourceChannelName,
					self.devicesData[opt.sourceDevice]?.name ?? '',
					opt[`destinationChannel_${opt.destinationDevice}`],
				)
			},
		},

		clearCrosspoint: {
			name: 'Clear Crosspoint',
			options: [
				{
					type: 'textinput',
					label: 'Destination Device',
					tooltip: 'Enter either device name or device IP',
					id: 'destinationDeviceAdddress',
					default: 'MyDanteDeviceName',
					useVariables: true,
				},
				{
					type: 'checkbox',
					label: 'Clear every channel on the device',
					id: 'clearAll',
					default: false,
					// required: this option is referenced by an isVisibleExpression below
					disableAutoExpression: true,
				},
				{
					type: 'textinput',
					label: 'Destination Channel',
					tooltip: 'Enter either channer name or channel number',
					id: 'destinationChannelNumber',
					default: '1',
					useVariables: true,
					isVisibleExpression: `!$(options:clearAll)`,
				},
			],
			callback: async (action) => {
				const opt = action.options
				if (opt.clearAll) {
					clearAllCrosspoints(self, opt.destinationDeviceAdddress)
					return
				}
				clearCrosspoint(self, opt.destinationDeviceAdddress, opt.destinationChannelNumber)
			},
		},

		clearCrosspointDropDown: {
			name: 'Clear Crosspoint (drop down menu)',
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: self.devicesChoices.filter((choice) => hasRxChannels(self.devicesData[choice.id])),
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				{
					type: 'checkbox',
					label: 'Clear every channel on the device',
					id: 'clearAll',
					default: false,
					// required: this option is referenced by an isVisibleExpression below
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof ClearCrosspointDropDownOptions> => ({
						type: 'dropdown',
						label: 'Destination channel',
						id: `destinationChannel_${ip}`,
						choices: device.name ? (self.rxChannelsChoices[device.name] ?? []) : [],
						default: 0,
						isVisibleExpression: `$(options:destinationDevice) == '${ip}' && !$(options:clearAll)`,
					})),
			],
			callback: async (action) => {
				const opt = action.options
				if (opt.clearAll) {
					clearAllCrosspoints(self, opt.destinationDevice)
					return
				}
				clearCrosspoint(self, opt.destinationDevice, opt[`destinationChannel_${opt.destinationDevice}`])
			},
		},

		setDeviceName: {
			name: 'Set Device name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices,
					default: self.devicesChoices[0]?.id ?? '',
				},
				{
					type: 'textinput',
					label: 'New name',
					id: 'name',
					default: '',
					useVariables: true,
				},
			],
			callback: async (action) => {
				const opt = action.options
				setDeviceName(self, opt.device, opt.name)
			},
		},

		setDeviceNameCustom: {
			name: 'Set Device name (custom device)',
			options: [
				{
					type: 'textinput',
					label: 'Device',
					id: 'device',
					default: '',
					useVariables: true,
				},
				{
					type: 'textinput',
					label: 'New name',
					id: 'name',
					default: '',
					useVariables: true,
				},
			],
			callback: async (action) => {
				const opt = action.options
				setDeviceName(self, opt.device, opt.name)
			},
		},

		resetDeviceName: {
			name: 'Reset Device name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices,
					default: self.devicesChoices[0]?.id ?? '',
				},
			],
			callback: async (action) => {
				const opt = action.options
				resetDeviceName(self, opt.device)
			},
		},

		setRxChannelName: {
			name: 'Set Rx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices.filter((choice) => hasRxChannels(self.devicesData[choice.id])),
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: device.name ? (self.rxChannelsChoices[device.name] ?? []) : [],
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					})),
				{
					type: 'textinput',
					label: 'New name',
					id: 'newName',
					default: '',
					useVariables: true,
				},
			],
			callback: async (action) => {
				const opt = action.options
				setRxChannelName(self, opt.device, opt[`channel_${opt.device}`], opt.newName)
			},
		},

		resetRxChannelName: {
			name: 'Reset Rx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices.filter((choice) => hasRxChannels(self.devicesData[choice.id])),
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof ResetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: device.name ? (self.rxChannelsChoices[device.name] ?? []) : [],
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					})),
			],
			callback: async (action) => {
				const opt = action.options
				resetRxChannelName(self, opt.device, opt[`channel_${opt.device}`])
			},
		},

		setTxChannelName: {
			name: 'Set Tx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices.filter((choice) => hasTxChannels(self.devicesData[choice.id])),
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasTxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: device.name ? (self.txChannelsChoices[device.name] ?? []) : [],
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					})),
				{
					type: 'textinput',
					label: 'New name',
					id: 'newName',
					default: '',
					useVariables: true,
				},
			],
			callback: async (action) => {
				const opt = action.options
				setTxChannelName(self, opt.device, opt[`channel_${opt.device}`], opt.newName)
			},
		},

		resetTxChannelName: {
			name: 'Reset Tx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices.filter((choice) => hasTxChannels(self.devicesData[choice.id])),
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasTxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof ResetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: device.name ? (self.txChannelsChoices[device.name] ?? []) : [],
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					})),
			],
			callback: async (action) => {
				const opt = action.options
				resetTxChannelName(self, opt.device, opt[`channel_${opt.device}`])
			},
		},

		setLatency: {
			name: 'Set Latency',
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: self.devicesChoices,
					default: self.devicesChoices[0]?.id ?? '',
				},
				{
					type: 'number',
					label: 'Latency (in ms)',
					id: 'latency',
					default: 1,
					min: 0,
					max: 1000,
				},
			],
			callback: async (action) => {
				const opt = action.options
				setLatency(self, opt.destinationDevice, opt.latency)
			},
		},

		setSampleRateCustom: {
			name: 'Set Sample rate (custom)',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices,
					default: self.devicesChoices[0]?.id ?? '',
				},
				{
					type: 'number',
					label: 'Sample rate (in Hz)',
					id: 'sr',
					default: 48000,
					min: 8000,
					max: 384000,
					asInteger: true,
				},
			],
			callback: async (action) => {
				const opt = action.options
				setSampleRate(self, opt.device, opt.sr)
			},
		},

		setSampleRate: {
			name: 'Set Sample rate',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices,
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData).map(
					([ip, device]): SomeCompanionActionInputField<keyof SetSampleRateOptions> => ({
						type: 'dropdown',
						label: 'Sample rate',
						id: `sr_${ip}`,
						choices: array2choices(device.srOptions, (f) => (Number(f) / 1000).toString() + ' kHz') ?? [],
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					}),
				),
			],
			callback: async (action) => {
				const opt = action.options
				const ip = opt.device
				setSampleRate(self, ip, opt[`sr_${ip}`])
			},
		},

		setPullup: {
			name: 'Set Sample rate pullup',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices,
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData).map(
					([ip, device]): SomeCompanionActionInputField<keyof SetPullupOptions> => ({
						type: 'dropdown',
						label: 'Sample rate pullup',
						id: `pullup_${ip}`,
						choices: object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions),
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					}),
				),
			],
			callback: async (action) => {
				const opt = action.options
				const ip = opt.device
				setPullup(self, ip, opt[`pullup_${ip}`])
			},
		},

		setEncoding: {
			name: 'Set Encoding',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices,
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData).map(
					([ip, device]): SomeCompanionActionInputField<keyof SetEncodingOptions> => ({
						type: 'dropdown',
						label: 'Encoding',
						id: `encoding_${ip}`,
						choices: object2PartialChoices(DANTE_CONST.ENCODINGS, device.encodingOptions),
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					}),
				),
			],
			callback: async (action) => {
				const opt = action.options
				const device = opt.device
				setEncoding(self, device, opt[`encoding_${device}`])
			},
		},

		setOutputLevel: {
			name: 'Set Output Level',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices.filter((choice) => hasRxChannels(self.devicesData[choice.id])),
					default: self.devicesChoices[0]?.id ?? '',
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetOutputLevelOptions> => ({
						type: 'dropdown',
						label: 'Channel',
						id: `channel_${ip}`,
						choices: device.name ? (self.rxChannelsChoices[device.name] ?? []) : [],
						default: 0,
						isVisibleExpression: `$(options:device) == '${ip}'`,
					})),
				{
					type: 'dropdown',
					label: 'Level',
					id: 'level',
					choices: object2choices(DANTE_CONST.LEVELS),
					default: 2,
				},
			],
			callback: async (action) => {
				const opt = action.options
				setLevel(self, opt.device, 'out', opt[`channel_${opt.device}`], opt.level)
			},
		},

		refresh: {
			name: 'Refresh parameters',
			options: [],
			callback: async () => {
				refreshSettings(self)
				refreshArc(self)
			},
		},
	}

	self.setActionDefinitions(actions)
}
