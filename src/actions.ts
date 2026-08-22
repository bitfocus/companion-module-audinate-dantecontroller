import {
	createModuleLogger,
	type CompanionActionDefinitions,
	type SomeCompanionActionInputField,
} from '@companion-module/base'
import {
	array2choices,
	audioDeviceChoices,
	channelChoices,
	channelRangeDescription,
	clearAllCrosspoints,
	clearCrosspoint,
	currentChoiceId,
	DANTE_CONST,
	deviceByIdentifier,
	deviceOptionValue,
	deviceSelectedExpression,
	devicesWithOptions,
	findDeviceIpByName,
	findRxChannelByName,
	findTxChannelByName,
	firstChoiceId,
	getChannelSubscriptionName,
	getRxChannelSource,
	makeCrosspoint,
	object2choices,
	object2PartialChoices,
	orPlaceholder,
	refreshArc,
	refreshSettings,
	resolveDeviceIp,
	resetDeviceName,
	resetRxChannelName,
	resetTxChannelName,
	rxDeviceChoices,
	setDeviceName,
	setEncoding,
	setLatency,
	setLevel,
	setPullup,
	setRxChannelName,
	setSampleRate,
	setTxChannelName,
	txDeviceChoices,
} from './api/index.js'
import type DanteInstance from './main.js'

const logger = createModuleLogger('actions')

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
	/** String, because the choice ids these dropdowns carry are strings. */
} & Record<`sr_${string}`, string>

type SetPullupOptions = {
	device: string
	/** String, because the choice ids these dropdowns carry are strings. */
} & Record<`pullup_${string}`, string>

type SetEncodingOptions = {
	device: string
	/** String, because the choice ids these dropdowns carry are strings. */
} & Record<`encoding_${string}`, string>

type SetOutputLevelOptions = {
	device: string
	/** String, because `object2choices` builds ids from `Object.entries` and so always yields strings. */
	level: string
} & Record<`channel_${string}`, number>

/**
 * The sentinel a Refresh action stores to mean "every known device".
 *
 * A device could in principle be named `all`, in which case it is refreshed along with everything
 * else rather than on its own. Harmless: refreshing only reads, so the cost of the collision is a
 * few extra queries.
 */
export const REFRESH_ALL = 'all'

type RefreshOptions = {
	device: string
}

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
	refresh: { options: RefreshOptions }
}

/**
 * Builds and registers this instance's action definitions, including one
 * per-device dropdown option (and its visibility expression) for each known Dante device.
 */
export function UpdateActions(self: DanteInstance): void {
	const actions: CompanionActionDefinitions<ActionSchema> = {
		makeCrosspoint: {
			name: 'Crosspoint - Make (custom)',
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
			name: 'Crosspoint - Make',
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => channelChoices(self, device, 'rx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof MakeCrosspointDropDownOptions> => ({
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
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => channelChoices(self, device, 'tx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof MakeCrosspointDropDownOptions> => ({
						type: 'dropdown',
						label: 'Source channel',
						id: `sourceChannel_${device.name}`,
						// The one channel dropdown where "None" means something: routing a destination to
						// no source is how a crosspoint is cleared, so this action can both make and break
						// a route. The default is still the first real channel, not None.
						choices: [{ id: 0, label: 'None (clear the crosspoint)' }, ...channelChoices(self, device, 'tx')],
						default: firstChoiceId(channelChoices(self, device, 'tx'), 0),
						expressionDescription: channelRangeDescription(channelChoices(self, device, 'tx'), device.name ?? '', true),
						allowCustom: true,
						isVisibleExpression: deviceSelectedExpression('sourceDevice', device.name ?? '', ip),
					})),
			],
			// Learn the source device and channel from the destination's current subscription. The
			// source channel option id is per-device, so the learnt device decides which key to return.
			learn: (action) => {
				const opt = action.options
				const source = getRxChannelSource(
					self,
					opt.destinationDevice,
					deviceOptionValue<number>(self, opt, 'destinationChannel', opt.destinationDevice, 0),
				)
				if (!source) return undefined

				// The device the route names must be one the picker offers, which is keyed by name.
				const sourceIp = findDeviceIpByName(self, source.deviceName)
				if (!sourceIp) return undefined

				const sourceChannel = findTxChannelByName(self, sourceIp, source.channelName)
				if (sourceChannel?.number === undefined) return undefined

				// Built by assignment, not as one literal: TypeScript widens a computed key in an object
				// literal to `string`, which no longer matches the per-device option key type.
				const learnt: Partial<MakeCrosspointDropDownOptions> = { sourceDevice: source.deviceName }
				learnt[`sourceChannel_${source.deviceName}`] = sourceChannel.number
				return learnt
			},
			callback: async (action) => {
				const opt = action.options
				const sourceChannelNumber = deviceOptionValue<number>(self, opt, 'sourceChannel', opt.sourceDevice, 0)
				const destinationChannel = deviceOptionValue<number>(self, opt, 'destinationChannel', opt.destinationDevice, 0)

				// No source means no route: clear the destination rather than subscribing it to nothing.
				if (!sourceChannelNumber) {
					clearCrosspoint(self, opt.destinationDevice, destinationChannel)
					return
				}

				const sourceChannel =
					deviceByIdentifier(self, opt.sourceDevice)?.tx?.[sourceChannelNumber] ??
					findTxChannelByName(self, opt.sourceDevice, String(sourceChannelNumber))
				const sourceChannelName = getChannelSubscriptionName(sourceChannel) || String(sourceChannelNumber)
				makeCrosspoint(
					self,
					opt.destinationDevice,
					sourceChannelName,
					deviceByIdentifier(self, opt.sourceDevice)?.name ?? '',
					destinationChannel,
				)
			},
		},

		clearCrosspoint: {
			name: 'Crosspoint - Clear (custom)',
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
			name: 'Crosspoint - Clear',
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
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
					.filter(([, device]) => channelChoices(self, device, 'rx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof ClearCrosspointDropDownOptions> => ({
						type: 'dropdown',
						label: 'Destination channel',
						id: `destinationChannel_${device.name}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
						expressionDescription: channelRangeDescription(channelChoices(self, device, 'rx'), device.name ?? ''),
						// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
						// allowCustom keeps actions still holding it parseable rather than failing outright
						allowCustom: true,
						isVisibleExpression: `(${deviceSelectedExpression('destinationDevice', device.name ?? '', ip)}) && !$(options:clearAll)`,
					})),
			],
			callback: async (action) => {
				const opt = action.options
				if (opt.clearAll) {
					clearAllCrosspoints(self, opt.destinationDevice)
					return
				}
				clearCrosspoint(
					self,
					opt.destinationDevice,
					deviceOptionValue<number>(self, opt, 'destinationChannel', opt.destinationDevice, 0),
				)
			},
		},

		setDeviceName: {
			name: 'Device Name - Set',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: orPlaceholder(self.devicesChoices, 'No devices found'),
					default: firstChoiceId(orPlaceholder(self.devicesChoices, 'No devices found'), ''),
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
			name: 'Device Name - Set (custom)',
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
			name: 'Device Name - Reset',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: orPlaceholder(self.devicesChoices, 'No devices found'),
					default: firstChoiceId(orPlaceholder(self.devicesChoices, 'No devices found'), ''),
				},
			],
			callback: async (action) => {
				const opt = action.options
				resetDeviceName(self, opt.device)
			},
		},

		setRxChannelName: {
			name: 'Rx Channel Name - Set',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => channelChoices(self, device, 'rx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'Channel',
						id: `channel_${device.name}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
						expressionDescription: channelRangeDescription(channelChoices(self, device, 'rx'), device.name ?? ''),
						// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
						// allowCustom keeps actions still holding it parseable rather than failing outright
						allowCustom: true,
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
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
				const name = deviceByIdentifier(self, opt.device)?.rx?.[
					deviceOptionValue<number>(self, opt, 'channel', opt.device, 0)
				]?.name
				return name ? { newName: name } : undefined
			},
			callback: async (action) => {
				const opt = action.options
				setRxChannelName(self, opt.device, deviceOptionValue<number>(self, opt, 'channel', opt.device, 0), opt.newName)
			},
		},

		resetRxChannelName: {
			name: 'Rx Channel Name - Reset',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => channelChoices(self, device, 'rx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof ResetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'Channel',
						id: `channel_${device.name}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
						expressionDescription: channelRangeDescription(channelChoices(self, device, 'rx'), device.name ?? ''),
						// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
						// allowCustom keeps actions still holding it parseable rather than failing outright
						allowCustom: true,
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
					})),
			],
			callback: async (action) => {
				const opt = action.options
				resetRxChannelName(self, opt.device, deviceOptionValue<number>(self, opt, 'channel', opt.device, 0))
			},
		},

		setTxChannelName: {
			name: 'Tx Channel Name - Set',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: txDeviceChoices(self),
					default: firstChoiceId(txDeviceChoices(self), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => channelChoices(self, device, 'tx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'Channel',
						id: `channel_${device.name}`,
						choices: channelChoices(self, device, 'tx'),
						default: firstChoiceId(channelChoices(self, device, 'tx'), 0),
						expressionDescription: channelRangeDescription(channelChoices(self, device, 'tx'), device.name ?? ''),
						// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
						// allowCustom keeps actions still holding it parseable rather than failing outright
						allowCustom: true,
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
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
				const channel = deviceByIdentifier(self, opt.device)?.tx?.[
					deviceOptionValue<number>(self, opt, 'channel', opt.device, 0)
				]
				const name = getChannelSubscriptionName(channel)
				return name ? { newName: name } : undefined
			},
			callback: async (action) => {
				const opt = action.options
				setTxChannelName(self, opt.device, deviceOptionValue<number>(self, opt, 'channel', opt.device, 0), opt.newName)
			},
		},

		resetTxChannelName: {
			name: 'Tx Channel Name - Reset',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: txDeviceChoices(self),
					default: firstChoiceId(txDeviceChoices(self), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => channelChoices(self, device, 'tx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof ResetChannelNameOptions> => ({
						type: 'dropdown',
						label: 'Channel',
						id: `channel_${device.name}`,
						choices: channelChoices(self, device, 'tx'),
						default: firstChoiceId(channelChoices(self, device, 'tx'), 0),
						expressionDescription: channelRangeDescription(channelChoices(self, device, 'tx'), device.name ?? ''),
						// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
						// allowCustom keeps actions still holding it parseable rather than failing outright
						allowCustom: true,
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
					})),
			],
			callback: async (action) => {
				const opt = action.options
				resetTxChannelName(self, opt.device, deviceOptionValue<number>(self, opt, 'channel', opt.device, 0))
			},
		},

		setLatency: {
			name: 'Latency - Set',
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
				const latency = deviceByIdentifier(self, action.options.destinationDevice)?.latency
				return latency === undefined ? undefined : { latency }
			},
			callback: async (action) => {
				const opt = action.options
				setLatency(self, opt.destinationDevice, opt.latency)
			},
		},

		setSampleRateCustom: {
			name: 'Sample Rate - Set (custom)',
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
			name: 'Sample Rate - Set',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: devicesWithOptions(self, 'srOptions'),
					default: firstChoiceId(devicesWithOptions(self, 'srOptions'), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				// A dropdown with no choices can never hold a valid value, and Companion refuses to parse
				// the whole action when one is present - so only emit these for devices that report options.
				...Object.entries(self.devicesData)
					.filter(([, device]) => (device.srOptions?.length ?? 0) > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetSampleRateOptions> => ({
						type: 'dropdown',
						label: 'Sample rate',
						id: `sr_${device.name}`,
						choices: array2choices(device.srOptions, (f) => (Number(f) / 1000).toString() + ' kHz') ?? [],
						// open on the rate the device is actually running, not merely the first it supports
						default: currentChoiceId(
							array2choices(device.srOptions, (f) => (Number(f) / 1000).toString() + ' kHz') ?? [],
							device.sr,
							'',
						),
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
					})),
			],
			learn: (action) => {
				const device = deviceByIdentifier(self, action.options.device)
				if (!device?.name || device.sr === undefined) return undefined

				const choices = array2choices(device.srOptions, (f) => (Number(f) / 1000).toString() + ' kHz') ?? []
				if (!choices.some((choice) => String(choice.id) === String(device.sr))) return undefined

				// keyed by name, matching the option this definition declares
				const learnt: Partial<SetSampleRateOptions> = {}
				learnt[`sr_${device.name}`] = String(device.sr)
				return learnt
			},
			callback: async (action) => {
				const opt = action.options
				// the stored identifier, which is the device name for anything saved recently and an
				// address for older actions - it suffixes the option key either way, and sendCommand
				// resolves it to an address
				const device = opt.device
				setSampleRate(self, device, Number(deviceOptionValue<string>(self, opt, 'sr', device, '')))
			},
		},

		setPullup: {
			name: 'Sample Rate Pullup - Set',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: devicesWithOptions(self, 'pullupOptions'),
					default: firstChoiceId(devicesWithOptions(self, 'pullupOptions'), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				// A dropdown with no choices can never hold a valid value, and Companion refuses to parse
				// the whole action when one is present - so only emit these for devices that report options.
				...Object.entries(self.devicesData)
					.filter(([, device]) => (device.pullupOptions?.length ?? 0) > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetPullupOptions> => ({
						type: 'dropdown',
						label: 'Sample rate pullup',
						id: `pullup_${device.name}`,
						choices: object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions),
						default: currentChoiceId(
							object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions),
							device.pullup,
							'',
						),
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
					})),
			],
			learn: (action) => {
				const device = deviceByIdentifier(self, action.options.device)
				if (!device?.name || device.pullup === undefined) return undefined

				// device.pullup is the decoded label ('NONE'), the option value is the underlying code
				const choices = object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions)
				const match = choices.find((choice) => choice.label === device.pullup)
				if (!match) return undefined

				const learnt: Partial<SetPullupOptions> = {}
				learnt[`pullup_${device.name}`] = String(match.id)
				return learnt
			},
			callback: async (action) => {
				const opt = action.options
				// the stored identifier, which is the device name for anything saved recently and an
				// address for older actions - it suffixes the option key either way, and sendCommand
				// resolves it to an address
				const device = opt.device
				setPullup(self, device, Number(deviceOptionValue<string>(self, opt, 'pullup', device, '')))
			},
		},

		setEncoding: {
			name: 'Encoding - Set',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: devicesWithOptions(self, 'encodingOptions'),
					default: firstChoiceId(devicesWithOptions(self, 'encodingOptions'), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				// A dropdown with no choices can never hold a valid value, and Companion refuses to parse
				// the whole action when one is present - so only emit these for devices that report options.
				...Object.entries(self.devicesData)
					.filter(([, device]) => (device.encodingOptions?.length ?? 0) > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetEncodingOptions> => ({
						type: 'dropdown',
						label: 'Encoding',
						id: `encoding_${device.name}`,
						choices: object2PartialChoices(DANTE_CONST.ENCODINGS, device.encodingOptions),
						default: currentChoiceId(
							object2PartialChoices(DANTE_CONST.ENCODINGS, device.encodingOptions),
							device.encoding,
							'',
						),
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
					})),
			],
			callback: async (action) => {
				const opt = action.options
				const device = opt.device
				setEncoding(self, device, Number(deviceOptionValue<string>(self, opt, 'encoding', device, '')))
			},
		},

		setOutputLevel: {
			name: 'Output Level - Set',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: rxDeviceChoices(self),
					default: firstChoiceId(rxDeviceChoices(self), ''),
					disableAutoExpression: true,
					// a value saved before devices were keyed by name is an address, which is no longer among
					// the choices - allowCustom lets it stay selected instead of failing to parse
					allowCustom: true,
				},
				...Object.entries(self.devicesData)
					.filter(([, device]) => channelChoices(self, device, 'rx').length > 0)
					.map(([ip, device]): SomeCompanionActionInputField<keyof SetOutputLevelOptions> => ({
						type: 'dropdown',
						label: 'Channel',
						id: `channel_${device.name}`,
						choices: channelChoices(self, device, 'rx'),
						default: firstChoiceId(channelChoices(self, device, 'rx'), 0),
						expressionDescription: channelRangeDescription(channelChoices(self, device, 'rx'), device.name ?? ''),
						// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
						// allowCustom keeps actions still holding it parseable rather than failing outright
						allowCustom: true,
						isVisibleExpression: deviceSelectedExpression('device', device.name ?? '', ip),
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
				const channelNumber = deviceOptionValue<number>(self, opt, 'channel', opt.device, 0)
				const levels = deviceByIdentifier(self, opt.device)?.output_levels
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
				setLevel(
					self,
					opt.device,
					'out',
					deviceOptionValue<number>(self, opt, 'channel', opt.device, 0),
					Number(opt.level),
				)
			},
		},

		refresh: {
			name: 'Parameters - Refresh',
			options: [
				{
					// A static field rather than the definition's `description`: no other action here sets
					// one, and a lone description renders differently enough to look like a mistake.
					type: 'static-text',
					id: 'info',
					label: 'When to use this',
					value:
						'Re-reads names, routing and settings from a device. Devices announce their own changes, ' +
						'so this is only needed when one of those announcements is missed - they are multicast, ' +
						'and can be dropped on a congested network.',
				},
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					// Every device, unfiltered: refreshing reads whatever a device has, and one with no
					// audio channels still has a name, versions and model information worth re-reading.
					choices: [{ id: REFRESH_ALL, label: 'All devices' }, ...self.devicesChoices],
					default: REFRESH_ALL,
					// see the device pickers above: a value saved before devices were keyed by name is an
					// address, which is no longer among the choices
					allowCustom: true,
				},
			],
			callback: async (action) => {
				const device = action.options.device

				if (device === REFRESH_ALL) {
					refreshSettings(self)
					refreshArc(self)
					return
				}

				const deviceIp = resolveDeviceIp(self, device)
				if (deviceIp === undefined) {
					logger.error(`Can't refresh '${device}' - no such device is known`)
					return
				}
				refreshSettings(self, deviceIp)
				refreshArc(self, deviceIp)
			},
		},
	}

	self.setActionDefinitions(actions)
}
