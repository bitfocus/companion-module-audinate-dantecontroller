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
	firstChoiceId,
	currentChoiceId,
	getRxChannelSource,
	findRxChannelByName,
	findDeviceIpByName,
	rxDeviceChoices,
	audioDeviceChoices,
	devicesWithOptions,
	txDeviceChoices,
	channelChoices,
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
	/** String, because `object2choices` builds ids from `Object.entries` and so always yields strings. */
	level: string
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
			// Learn the source from whatever the chosen destination is currently subscribed to. Only the
			// two source fields are returned - per the 2.0 contract, returning the destination fields
			// as well would overwrite any expression the user has entered in them.
			learn: (action) => {
				const opt = action.options
				const channel = findRxChannelByName(self, opt.destinationDeviceAddress, opt.destinationChannelNumber)
				const channelNumber = channel?.number ?? Number(opt.destinationChannelNumber)
				if (!Number.isFinite(channelNumber)) return undefined

				const source = getRxChannelSource(self, opt.destinationDeviceAddress, channelNumber)
				if (!source) return undefined

				return { sourceChannelName: source.channelName, sourceDeviceName: source.deviceName }
			},
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
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof MakeCrosspointDropDownOptions> => ({
						type: 'dropdown',
						label: 'Destination channel',
						id: `destinationChannel_${ip}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
						isVisibleExpression: `$(options:destinationDevice) == '${ip}'`,
					})),
				{
					type: 'dropdown',
					label: 'Source Device',
					id: 'sourceDevice',
					choices: txDeviceChoices(self),
					default: firstChoiceId(txDeviceChoices(self), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasTxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof MakeCrosspointDropDownOptions> => ({
						type: 'dropdown',
						label: 'Source channel',
						id: `sourceChannel_${ip}`,
						choices: channelChoices(self, device, 'tx'),
						default: firstChoiceId(channelChoices(self, device, 'tx'), 0),
						isVisibleExpression: `$(options:sourceDevice) == '${ip}'`,
					})),
			],
			// Learn the source device and channel from the destination's current subscription. The
			// source channel option id is per-device, so the learnt device decides which key to return.
			learn: (action) => {
				const opt = action.options
				const source = getRxChannelSource(
					self,
					opt.destinationDevice,
					opt[`destinationChannel_${opt.destinationDevice}`],
				)
				if (!source) return undefined

				const sourceIp = findDeviceIpByName(self, source.deviceName)
				if (!sourceIp) return undefined

				const sourceChannel = findTxChannelByName(self, sourceIp, source.channelName)
				if (sourceChannel?.number === undefined) return undefined

				// Built by assignment, not as one literal: TypeScript widens a computed key in an object
				// literal to `string`, which no longer matches the per-device option key type.
				const learnt: Partial<MakeCrosspointDropDownOptions> = { sourceDevice: sourceIp }
				learnt[`sourceChannel_${sourceIp}`] = sourceChannel.number
				return learnt
			},
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
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
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
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
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
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
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
			// Learn the new-name field from the channel's current name, as a starting point for an edit.
			learn: (action) => {
				const opt = action.options
				const name = self.devicesData[opt.device]?.rx?.[opt[`channel_${opt.device}`]]?.name
				return name ? { newName: name } : undefined
			},
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
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof ResetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
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
					choices: txDeviceChoices(self),
					default: firstChoiceId(txDeviceChoices(self), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasTxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: channelChoices(self, device, 'tx'),
						default: firstChoiceId(channelChoices(self, device, 'tx'), 0),
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
			// Learn from the channel label the device reports, falling back to its canonical name.
			learn: (action) => {
				const opt = action.options
				const channel = self.devicesData[opt.device]?.tx?.[opt[`channel_${opt.device}`]]
				const name = getChannelSubscriptionName(channel)
				return name ? { newName: name } : undefined
			},
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
					choices: txDeviceChoices(self),
					default: firstChoiceId(txDeviceChoices(self), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasTxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof ResetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'channel',
						id: `channel_${ip}`,
						choices: channelChoices(self, device, 'tx'),
						default: firstChoiceId(channelChoices(self, device, 'tx'), 0),
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
					choices: audioDeviceChoices(self),
					default: firstChoiceId(audioDeviceChoices(self), ''),
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
			learn: (action) => {
				const latency = self.devicesData[action.options.destinationDevice]?.latency
				return latency === undefined ? undefined : { latency }
			},
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
					choices: audioDeviceChoices(self),
					default: firstChoiceId(audioDeviceChoices(self), ''),
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
					choices: devicesWithOptions(self, 'srOptions'),
					default: firstChoiceId(devicesWithOptions(self, 'srOptions'), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData).map(
					([ip, device]): SomeCompanionActionInputField<keyof SetSampleRateOptions> => ({
						type: 'dropdown',
						label: 'Sample rate',
						id: `sr_${ip}`,
						choices: array2choices(device.srOptions, (f) => (Number(f) / 1000).toString() + ' kHz') ?? [],
						// open on the rate the device is actually running, not merely the first it supports
						default: currentChoiceId(
							array2choices(device.srOptions, (f) => (Number(f) / 1000).toString() + ' kHz') ?? [],
							device.sr,
							0,
						),
						isVisibleExpression: `$(options:device) == '${ip}'`,
					}),
				),
			],
			learn: (action) => {
				const ip = action.options.device
				const device = self.devicesData[ip]
				if (!device || device.sr === undefined) return undefined

				const choices = array2choices(device.srOptions, (f) => (Number(f) / 1000).toString() + ' kHz') ?? []
				if (!choices.some((choice) => String(choice.id) === String(device.sr))) return undefined

				const learnt: Partial<SetSampleRateOptions> = {}
				learnt[`sr_${ip}`] = Number(device.sr)
				return learnt
			},
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
					choices: devicesWithOptions(self, 'pullupOptions'),
					default: firstChoiceId(devicesWithOptions(self, 'pullupOptions'), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData).map(
					([ip, device]): SomeCompanionActionInputField<keyof SetPullupOptions> => ({
						type: 'dropdown',
						label: 'Sample rate pullup',
						id: `pullup_${ip}`,
						choices: object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions),
						default: currentChoiceId(
							object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions),
							device.pullup,
							0,
						),
						isVisibleExpression: `$(options:device) == '${ip}'`,
					}),
				),
			],
			learn: (action) => {
				const ip = action.options.device
				const device = self.devicesData[ip]
				if (!device || device.pullup === undefined) return undefined

				// device.pullup is the decoded label ('NONE'), the option value is the underlying code
				const choices = object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions)
				const match = choices.find((choice) => choice.label === device.pullup)
				if (!match) return undefined

				const learnt: Partial<SetPullupOptions> = {}
				learnt[`pullup_${ip}`] = Number(match.id)
				return learnt
			},
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
					choices: devicesWithOptions(self, 'encodingOptions'),
					default: firstChoiceId(devicesWithOptions(self, 'encodingOptions'), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData).map(
					([ip, device]): SomeCompanionActionInputField<keyof SetEncodingOptions> => ({
						type: 'dropdown',
						label: 'Encoding',
						id: `encoding_${ip}`,
						choices: object2PartialChoices(DANTE_CONST.ENCODINGS, device.encodingOptions),
						default: currentChoiceId(
							object2PartialChoices(DANTE_CONST.ENCODINGS, device.encodingOptions),
							device.encoding,
							0,
						),
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
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => hasRxChannels(device))
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetOutputLevelOptions> => ({
						type: 'dropdown',
						label: 'Channel',
						id: `channel_${ip}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
						isVisibleExpression: `$(options:device) == '${ip}'`,
					})),
				{
					type: 'dropdown',
					label: 'Level',
					id: 'level',
					choices: object2choices(DANTE_CONST.LEVELS),
					// '2' (+4dBu), as a string to match the choice ids - the numeric 2 it used to be
					// matched nothing, so the dropdown opened with no level selected
					default: '2',
				},
			],
			// Learn the level of the selected output channel, where the device reports one. Levels are
			// only known for devices that answer the codec query - many do not, in which case this
			// declines rather than guessing.
			learn: (action) => {
				const opt = action.options
				const channelNumber = opt[`channel_${opt.device}`]
				const levels = self.devicesData[opt.device]?.output_levels
				const current = levels?.[channelNumber - 1]
				if (current === undefined) return undefined

				// output_levels holds decoded labels ('+4dBu'); the option value is the level's code
				const match = object2choices(DANTE_CONST.LEVELS).find(
					(choice) => choice.label === String(current) || String(choice.id) === String(current),
				)
				return match ? { level: String(match.id) } : undefined
			},
			callback: async (action) => {
				const opt = action.options
				setLevel(self, opt.device, 'out', opt[`channel_${opt.device}`], Number(opt.level))
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
