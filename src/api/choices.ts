/**
 * Building the dropdown choice lists that actions and feedbacks are made of.
 */

import { createModuleLogger, type DropdownChoice } from '@companion-module/base'
import type DanteInstance from '../main.js'
import type { DeviceData } from './types.js'
import {
	deviceByIdentifier,
	getChannelSubscriptionName,
	hasRxChannels,
	hasTxChannels,
	scheduleUpdateData,
} from './devices.js'

const logger = createModuleLogger('api:choices')

/**
 * The id to use as a dropdown's default: the first entry of the list that dropdown actually offers.
 *
 * Dropdowns whose choices are filtered must take their default from the filtered list. Defaulting
 * to the first device overall can select one the filter removed, leaving the control showing a
 * value that is not selectable and an action pointed at a device that cannot perform it.
 */
export function firstChoiceId<Id extends string | number, Fallback extends string | number>(
	choices: DropdownChoice<Id>[],
	fallback: Fallback,
): Id | Fallback {
	return choices[0]?.id ?? fallback
}

/**
 * The id to use as a dropdown's default when the device has a current value for that setting: the
 * choice matching what the device reports, falling back to the first choice it offers.
 *
 * Matches on id or label because the two are not stored consistently - a sample rate is kept as the
 * raw number (`48000`, matching the choice id) while encoding and pullup are kept as their decoded
 * label (`PCM24`, `NONE`), the choice ids for those being the underlying codes.
 */
export function currentChoiceId<Id extends string | number, Fallback extends string | number>(
	choices: DropdownChoice<Id>[],
	current: string | number | undefined,
	fallback: Fallback,
): Id | Fallback {
	if (current !== undefined) {
		const wanted = String(current)
		// Two passes, so an exact id match always wins over a label match on an earlier entry - the
		// id is the authoritative value, the label only a fallback for the decoded-label cases.
		const byId = choices.find((choice) => String(choice.id) === wanted)
		if (byId) return byId.id
		const byLabel = choices.find((choice) => choice.label === wanted)
		if (byLabel) return byLabel.id
	}
	return firstChoiceId(choices, fallback)
}

/**
 * Guarantees a dropdown has something to offer.
 *
 * Companion validates a dropdown's value against its choices and refuses to parse the entire
 * action when no choice matches - which breaks the action outright, its learn included. An empty
 * list can therefore never be shipped, so an explanatory placeholder stands in until real choices
 * exist. Running an action left on the placeholder fails the usual way, with an unknown-device log.
 */
export function orPlaceholder(choices: DropdownChoice<string>[], label: string): DropdownChoice<string>[] {
	return choices.length > 0 ? choices : [{ id: '', label }]
}

/** Devices that have receive channels, as dropdown choices. */
export function rxDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => hasRxChannels(deviceByIdentifier(self, String(choice.id)))),
		'No devices with receive channels found',
	)
}

/** Devices that have transmit channels, as dropdown choices. */
export function txDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => hasTxChannels(deviceByIdentifier(self, String(choice.id)))),
		'No devices with transmit channels found',
	)
}

/**
 * Devices that carry audio, as dropdown choices.
 *
 * Excludes devices with neither receive nor transmit channels - a software controller, say - which
 * cannot have a sample rate, pullup, encoding or latency. Offering them means the per-device option
 * list below the picker is empty, which looks like the module failed rather than like a device that
 * has nothing to configure.
 */
export function audioDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => {
			const device = deviceByIdentifier(self, String(choice.id))
			return hasRxChannels(device) || hasTxChannels(device)
		}),
		'No devices with audio channels found',
	)
}

/**
 * Devices that reported options for a given setting, as dropdown choices.
 *
 * More precise than {@link audioDeviceChoices} for settings a device may simply not implement -
 * neither of the devices tested here supports sample rate pullup, so they never report pullup
 * options and offering them only yields an empty picker.
 *
 * Note this is empty until the device's settings reply arrives, so an action built during that
 * window briefly offers nothing. `UpdateActions` re-runs when device data changes, so it fills in
 * shortly after discovery. A list that stays empty means either nothing on the network supports
 * the setting, or no settings replies are arriving at all - which `configError` reports separately.
 */
export function devicesWithOptions(
	self: DanteInstance,
	options: 'srOptions' | 'pullupOptions' | 'encodingOptions',
): DropdownChoice<string>[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => (deviceByIdentifier(self, String(choice.id))?.[options]?.length ?? 0) > 0),
		'No devices report this setting',
	)
}

/** A device's rx or tx channel choices, or an empty list if it has none yet. */
export function channelChoices(
	self: DanteInstance,
	device: DeviceData,
	channelType: 'rx' | 'tx',
): DropdownChoice<number>[] {
	if (!device.name) return []
	const byDevice = channelType === 'rx' ? self.rxChannelsChoices : self.txChannelsChoices
	return byDevice[device.name] ?? []
}

/**
 * What a channel dropdown accepts, shown in place of the description while the field is in
 * expression mode.
 *
 * A field switched to expression mode shows no choices, so nothing otherwise tells the user what the
 * expression has to produce. Channel ids run 1..count with no gaps - see `updateChannelChoices` - so
 * the range is the whole story.
 */
export function channelRangeDescription(
	choices: DropdownChoice<number>[],
	deviceName: string,
	zeroClears = false,
): string {
	const clears = zeroClears ? ', where 0 clears the crosspoint' : ''
	return `Must evaluate to a channel number from ${zeroClears ? 0 : 1} to ${choices.length} on ${deviceName}${clears}`
}

/**
 * A visibility expression matching a device picker against one device.
 *
 * Matches the device name, which is what pickers store, *and* its current address, which is what
 * actions saved before devices were keyed by name still hold. Without the address arm those actions
 * show no per-device field at all: the option ids are keyed by name, so nothing matches and the
 * channel picker simply never appears.
 */
export function deviceSelectedExpression(pickerId: string, deviceName: string, deviceIp: string): string {
	return `$(options:${pickerId}) == '${deviceName}' || $(options:${pickerId}) == '${deviceIp}'`
}

/**
 * Reads a per-device option, accepting either key form.
 *
 * Fields are declared keyed by device name; an action saved earlier holds its value under the
 * device's address instead. The name is preferred so a re-saved action uses the current key.
 */
export function deviceOptionValue<T>(
	self: DanteInstance,
	options: Record<string, unknown>,
	prefix: string,
	identifier: string,
	fallback: T,
): T {
	const name = deviceByIdentifier(self, identifier)?.name
	const byName = name !== undefined ? options[`${prefix}_${name}`] : undefined
	return ((byName ?? options[`${prefix}_${identifier}`]) as T | undefined) ?? fallback
}

/** Adds a device to the `devicesChoices` dropdown list, keeping it sorted by label. */
export function insertDeviceChoice(self: DanteInstance, deviceIp: string, deviceName: string): void {
	// Make and model are not known yet - they arrive with the settings reply, which logs the fuller
	// line once it does. See `logDeviceIdentity`.
	logger.info(`Discovered ${deviceName} at ${deviceIp}`)

	self.devicesChoices.push({ id: deviceName, label: deviceName })
	self.devicesChoices.sort((deviceA, deviceB) => {
		return deviceA.label.localeCompare(deviceB.label)
	})
}

/**
 * Updates a device's label in the `devicesChoices` dropdown list if its name has changed,
 * re-sorting and rebuilding action/feedback/variable definitions when it does.
 */
export function updateDeviceChoice(self: DanteInstance, deviceIp: string, deviceName: string): void {
	// Choices are keyed by name, so a rename replaces the entry rather than relabelling it. Actions
	// referring to the old name keep their stored value - `allowCustom` lets it stay selected - but
	// will not resolve until they are pointed at the new name.
	const previousName = self.devicesData[deviceIp]?.name

	// Worth an info line either way: a rename silently breaks every action pointed at the old name.
	if (previousName && previousName !== deviceName) {
		logger.info(`Device renamed: '${previousName}' is now '${deviceName}' (${deviceIp})`)
	} else if (self.debug) {
		logger.debug(`Device name for ${deviceIp} confirmed as '${deviceName}'`)
	}
	const existing = self.devicesChoices.findIndex((choice) => choice.id === (previousName ?? deviceIp))
	if (existing !== -1) {
		self.devicesChoices.splice(existing, 1)
	}
	if (!self.devicesChoices.some((choice) => choice.id === deviceName)) {
		self.devicesChoices.push({ id: deviceName, label: deviceName })
		self.devicesChoices.sort((deviceA, deviceB) => deviceA.label.localeCompare(deviceB.label))
		scheduleUpdateData(self)
	}
}

/**
 * Creates or updates the tx/rx channel-name dropdown choices for a device, rebuilding
 * action/feedback/variable definitions if anything changed.
 */
export function updateChannelChoices(self: DanteInstance, deviceIp: string, channelType: 'tx' | 'rx'): void {
	if (!self.devicesData[deviceIp]?.[channelType]) {
		logger.error("ERROR : Can't update channelsChoices for device " + deviceIp)
		return
	}

	const deviceName = self.devicesData[deviceIp].name
	if (deviceName === undefined) return
	const ioObject = self.devicesData[deviceIp][channelType]
	if (ioObject === undefined) return

	// No "None" entry: every action taking a channel acts on that one channel, so a "none" selection
	// only means "do nothing". It also sorted first, which made it the default - so a freshly added
	// action silently did nothing until a channel was picked.
	const channelChoice: DropdownChoice<number>[] = []
	const choicesByDevice = channelType === 'tx' ? self.txChannelsChoices : self.rxChannelsChoices
	for (let i = 1; i <= (ioObject.count ?? 0); i++) {
		const channelName =
			channelType === 'tx' ? (getChannelSubscriptionName(ioObject[i]) ?? '') : (ioObject[i]?.name ?? '')
		channelChoice.push({ id: i, label: channelName })
	}

	const existing = choicesByDevice[deviceName]
	const changed =
		!existing ||
		existing.length !== channelChoice.length ||
		channelChoice.some((choice, index) => choice.label !== existing[index]?.label)
	if (changed) {
		logChannelNameChanges(deviceName, channelType, existing, channelChoice)
		choicesByDevice[deviceName] = channelChoice
		scheduleUpdateData(self)
	}
}

/**
 * Reports channel renames at info, and the first sight of a device's channels at debug.
 *
 * A channel name is what every crosspoint action and feedback is stored against, so a rename can
 * quietly break a whole page of buttons - the same reason a device rename is worth an info line.
 * The initial population is not a change and would otherwise log one line per channel per device on
 * every connect, so it stays at debug.
 */
function logChannelNameChanges(
	deviceName: string,
	channelType: 'tx' | 'rx',
	existing: DropdownChoice<number>[] | undefined,
	incoming: DropdownChoice<number>[],
): void {
	const direction = channelType === 'tx' ? 'transmit' : 'receive'

	if (!existing) {
		logger.debug(`${deviceName}: learned ${incoming.length} ${direction} channel(s)`)
		return
	}

	if (existing.length !== incoming.length) {
		logger.info(`${deviceName}: ${direction} channel count changed from ${existing.length} to ${incoming.length}`)
	}

	for (const [index, choice] of incoming.entries()) {
		const before = existing[index]
		// only channels that were already there can have been renamed; the rest are new
		if (before === undefined || before.label === choice.label) continue
		logger.info(`${deviceName} ${direction} channel ${choice.id} renamed: '${before.label}' -> '${choice.label}'`)
	}
}

/** Converts a plain `{ id: label }` map into a Companion dropdown `choices` array. */
export function object2choices<Key extends string | number>(obj: Record<Key, string>): DropdownChoice<`${Key}`>[] {
	const choices: DropdownChoice<`${Key}`>[] = []
	// Object.entries stringifies numeric keys, so the ids are the string form of the code
	for (const [id, label] of Object.entries(obj) as [`${Key}`, string][]) {
		choices.push({ id, label })
	}
	return choices
}

/** Like {@link object2choices}, but only includes entries whose id is present in `optionsArray`. */
export function object2PartialChoices<Key extends string | number>(
	obj: Record<Key, string>,
	optionsArray: (string | number)[] | undefined,
): DropdownChoice<`${Key}`>[] {
	const choices: DropdownChoice<`${Key}`>[] = []
	for (const [id, label] of Object.entries(obj) as [`${Key}`, string][]) {
		if (optionsArray?.includes(id)) {
			choices.push({ id, label })
		}
	}
	return choices
}

/**
 * Converts an array of raw values into a Companion dropdown `choices` array, or `undefined` if `array` is nullish.
 */
export function array2choices<T extends string | number>(
	array: T[] | undefined,
	mapping?: (value: T) => string,
): DropdownChoice<T>[] | undefined {
	return array?.map((e) => {
		return { id: e, label: mapping ? mapping(e) : String(e) }
	})
}
