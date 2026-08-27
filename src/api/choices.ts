/**
 * Building the dropdown choice lists that actions and feedbacks are made of.
 */

import {
	createModuleLogger,
	type CompanionInputFieldDropdown,
	type CompanionInputFieldStaticText,
	type DropdownChoice,
} from '@companion-module/base'
import type DanteInstance from '../main.js'
import { CHANNEL_MEDIA_TYPE_LABELS, CHANNEL_MEDIA_TYPES, type ChannelMediaType, type DeviceData } from './types.js'
import {
	deviceByIdentifier,
	getChannelSubscriptionName,
	hasAudioRxChannels,
	hasAudioTxChannels,
	hasVideoRxChannels,
	hasVideoTxChannels,
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

/**
 * Devices that have receive channels, as dropdown choices.
 *
 * Audio or video: the picker is shared by both (see {@link CHANNEL_MEDIA_TYPES}), and a device with
 * only one of the two must still appear so its channels are reachable once that type is selected.
 */
export function rxDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => {
			const device = deviceByIdentifier(self, String(choice.id))
			return hasAudioRxChannels(device) || hasVideoRxChannels(device)
		}),
		'No devices with receive channels found',
	)
}

/** Devices that have transmit channels, as dropdown choices. See {@link rxDeviceChoices}. */
export function txDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => {
			const device = deviceByIdentifier(self, String(choice.id))
			return hasAudioTxChannels(device) || hasVideoTxChannels(device)
		}),
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
			return hasAudioRxChannels(device) || hasAudioTxChannels(device)
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

/** A device's rx or tx audio channel choices, or an empty list if it has none yet. */
export function audioChannelChoices(
	self: DanteInstance,
	device: DeviceData,
	channelType: 'rx' | 'tx',
): DropdownChoice<number>[] {
	if (!device.name) return []
	const byDevice = channelType === 'rx' ? self.rxChannelsChoices : self.txChannelsChoices
	return byDevice[device.name] ?? []
}

/** A device's rx or tx video channel choices, or an empty list if it has none yet. */
export function videoChannelChoices(
	self: DanteInstance,
	device: DeviceData,
	channelType: 'rx' | 'tx',
): DropdownChoice<number>[] {
	if (!device.name) return []
	// The ?? {} guards a DanteInstance-like test double that predates video and so has no reason to
	// set this field - a real instance always has it, initialized alongside rxChannelsChoices.
	const byDevice = (channelType === 'rx' ? self.videoRxChannelsChoices : self.videoTxChannelsChoices) ?? {}
	return byDevice[device.name] ?? []
}

/**
 * A device's rx or tx channel choices for the given {@link ChannelMediaType} - the one dispatch
 * point an action/feedback needs regardless of how many media types this module ends up supporting.
 */
export function mediaChannelChoices(
	self: DanteInstance,
	device: DeviceData,
	channelType: 'rx' | 'tx',
	mediaType: ChannelMediaType,
): DropdownChoice<number>[] {
	return mediaType === 'video'
		? videoChannelChoices(self, device, channelType)
		: audioChannelChoices(self, device, channelType)
}

/**
 * The per-device option id prefix for a channel picker of the given media type.
 *
 * Audio keeps the original unprefixed `base` id, so existing saved actions/feedbacks (all audio,
 * from before video existed) keep resolving against the same option key. Every other media type
 * gets its own suffixed id (`${base}Video`, and so on for whatever comes after it), so a device
 * can offer independent audio and video channel pickers side by side.
 *
 * `mediaType` accepts `undefined` so a callback can pass `action.options.channelType` straight
 * through before the upgrade script backfilling it to `'audio'` has necessarily run (or in a test
 * building options by hand) - treated the same as `'audio'` rather than throwing.
 */
export function channelOptionPrefix(base: string, mediaType: ChannelMediaType | undefined): string {
	if (!mediaType || mediaType === 'audio') return base
	return `${base}${mediaType[0].toUpperCase()}${mediaType.slice(1)}`
}

/**
 * The Audio/Video channel-type picker every crosspoint action/feedback shares - the option every
 * per-device channel field's `isVisibleExpression` checks alongside its device, via
 * {@link perDeviceChannelFields}. `disableAutoExpression` is required for exactly that reason.
 */
export function channelTypeOption<Key extends string>(id: Key): CompanionInputFieldDropdown<Key> {
	return {
		type: 'dropdown',
		label: 'Channel Type',
		id,
		choices: CHANNEL_MEDIA_TYPES.map((mediaType) => ({ id: mediaType, label: CHANNEL_MEDIA_TYPE_LABELS[mediaType] })),
		default: 'audio',
		disableAutoExpression: true,
	}
}

/**
 * Builds the per-device, per-media-type channel dropdown fields a crosspoint action/feedback needs:
 * one dropdown per (device, media type) combination that actually has channels of that type, shown
 * only when both its device and its media type are selected.
 *
 * Centralizing this is what makes adding a further {@link ChannelMediaType} later a one-line change
 * (an entry in that list, plus wiring its own channel storage into `mediaChannelChoices`) rather
 * than a new copy of this loop in every action and feedback that has a per-device channel picker.
 *
 * @param devicePickerId The id of this definition's device dropdown, which `channelType` is checked
 * alongside in each field's `isVisibleExpression`.
 * @param basePrefix The option id prefix for the audio case - see {@link channelOptionPrefix}.
 * @param direction Which of the device's channel lists to offer.
 * @param label The field label for the audio case (matching what each call site used before video
 * existed - "Channel", "Destination channel", "Source channel"); every other media type gets it
 * prefixed with its own name ("Video channel"), so two simultaneously-declared fields for the same
 * device are never confused for each other outside of their `isVisibleExpression`-driven display.
 * @param noneOption When given, prepended to every media type's choices - see the source-channel
 * pickers, where selecting "None" is how a crosspoint is cleared. Omit it for every other picker
 * (destinations, and anything that only ever reads a channel rather than routing to it).
 * @param extraVisibleCondition An additional expression ANDed into every field's
 * `isVisibleExpression` - for the one picker (Crosspoint Clear's destination channel) that must
 * also hide itself when its action's "clear every channel" checkbox is on.
 */
export function perDeviceChannelFields<Key extends string>(
	self: DanteInstance,
	devicePickerId: string,
	basePrefix: string,
	direction: 'rx' | 'tx',
	label: string,
	noneOption?: DropdownChoice<number>,
	extraVisibleCondition?: string,
): CompanionInputFieldDropdown<Key>[] {
	const fields: CompanionInputFieldDropdown<Key>[] = []

	for (const mediaType of CHANNEL_MEDIA_TYPES) {
		for (const { name, device, ips } of devicesByName(self)) {
			const choices = mediaChannelChoices(self, device, direction, mediaType)
			if (choices.length === 0) continue

			// deviceSelectedExpression contains `||`, which binds looser than `&&` - bracket it (and, if
			// there's an extraVisibleCondition too, the whole device+type clause) so a later `&&` can't
			// silently swallow one arm of the `||`.
			const deviceAndType = `(${deviceSelectedExpression(devicePickerId, name, ...ips)}) && $(options:channelType) == '${mediaType}'`
			const isVisibleExpression = extraVisibleCondition
				? `(${deviceAndType}) && ${extraVisibleCondition}`
				: deviceAndType

			fields.push({
				type: 'dropdown',
				label: mediaType === 'audio' ? label : `${CHANNEL_MEDIA_TYPE_LABELS[mediaType]} ${label.toLowerCase()}`,
				id: `${channelOptionPrefix(basePrefix, mediaType)}_${name}` as Key,
				choices: noneOption ? [noneOption, ...choices] : choices,
				// The default comes from `choices` alone, never `[noneOption, ...choices]`: None sorts
				// first, so including it here would make a freshly-added field default to "no route".
				default: firstChoiceId(choices, 0),
				expressionDescription: channelRangeDescription(choices, name, noneOption !== undefined),
				// a channel dropdown used to offer a "None" entry with id 0, and that was the default -
				// allowCustom keeps actions still holding it parseable rather than failing outright
				allowCustom: true,
				isVisibleExpression,
			})
		}
	}

	return fields
}

/** How a channel direction reads in a sentence aimed at the user. */
const DIRECTION_LABELS: Record<'rx' | 'tx', string> = { rx: 'receive', tx: 'transmit' }

/**
 * Warnings that stand in for a channel picker the device cannot offer.
 *
 * {@link perDeviceChannelFields} generates a picker only for the device/media-type pairs that have
 * channels, so choosing a device with none of the selected type shows *nothing* - the action looks
 * incomplete for no stated reason and only fails once run, in a log line the user has to go find.
 *
 * The device dropdowns cannot avoid offering such a device: a dropdown's `choices` are fixed when
 * definitions are built and cannot be narrowed by the value of another option, so one list has to
 * serve every media type. It is therefore built from devices having channels of *any* media type in
 * the direction, which leaves an audio-only device selectable while Channel Type is Video. This
 * fills the resulting silence with an explanation at design time.
 *
 * Emitted for both directions of the mismatch, so a video-only device selected in Audio mode is
 * explained just as an audio-only device in Video mode is. Devices with no channels at all in this
 * direction are skipped - the dropdown never offers them, so there is nothing to explain.
 *
 * Takes no extra visibility condition, deliberately. Crosspoint Clear hides its channel picker while
 * "clear every channel" is ticked and this warning was originally hidden alongside it, which implied
 * that clearing everything steps outside the selected Channel Type. It does not - a device with no
 * channels of that type has nothing to clear either way - so the warning stays put.
 */
export function perDeviceMissingChannelWarnings(
	self: DanteInstance,
	devicePickerId: string,
	direction: 'rx' | 'tx',
): CompanionInputFieldStaticText[] {
	const fields: CompanionInputFieldStaticText[] = []

	for (const mediaType of CHANNEL_MEDIA_TYPES) {
		for (const { name, device, ips } of devicesByName(self)) {
			if (mediaChannelChoices(self, device, direction, mediaType).length > 0) continue
			const offeredAtAll = CHANNEL_MEDIA_TYPES.some(
				(otherType) => mediaChannelChoices(self, device, direction, otherType).length > 0,
			)
			if (!offeredAtAll) continue

			// Bracketed exactly as in perDeviceChannelFields: deviceSelectedExpression contains `||`,
			// which binds looser than the `&&` joining it to the channel-type test.
			const isVisibleExpression = `(${deviceSelectedExpression(devicePickerId, name, ...ips)}) && $(options:channelType) == '${mediaType}'`

			const mediaLabel = CHANNEL_MEDIA_TYPE_LABELS[mediaType]
			fields.push({
				type: 'static-text',
				// Not `channelOptionPrefix`: these hold no value, so there is no saved-config
				// compatibility to preserve and every media type can carry its own name.
				id: `${devicePickerId}No${mediaLabel}${direction.toUpperCase()}Channels_${name}`,
				label: `No ${mediaLabel.toLowerCase()} channels`,
				value:
					`${name} has no ${mediaLabel.toLowerCase()} ${DIRECTION_LABELS[direction]} channels, so there ` +
					`is no channel to pick and this will do nothing when run. Choose a different device, or change ` +
					`Channel Type.`,
				isVisibleExpression,
			})
		}
	}

	return fields
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
 *
 * Takes any number of addresses because one name can be announced from several - see
 * {@link devicesByName}. All of them are matched, so an older action holding whichever address it
 * was saved against still resolves.
 */
export function deviceSelectedExpression(pickerId: string, deviceName: string, ...deviceIps: string[]): string {
	return [deviceName, ...deviceIps].map((value) => `$(options:${pickerId}) == '${value}'`).join(' || ')
}

/** One device, as the per-device option builders see it: a name, its record, and its addresses. */
export interface NamedDevice {
	name: string
	device: DeviceData
	ips: string[]
}

/**
 * The devices to build per-device option fields from: one entry per distinct *name*.
 *
 * `devicesData` is keyed by address, and two addresses can carry the same device name - a device
 * whose address changed re-registers under the new one while the old record waits out its offline
 * timeout, and a Companion host on both a primary and a secondary Dante network sees one device
 * announce itself from each. Building fields straight from `Object.entries(devicesData)` then emits
 * two options with the same `<prefix>_${name}` id, which Companion cannot tell apart.
 *
 * Grouping first is enough to make that impossible, and loses nothing: everything a per-device field
 * needs is keyed by name too (`rxChannelsChoices` and friends), so the duplicate record could only
 * ever have produced an identical field. Its address is kept in `ips` so the visibility expression
 * still matches actions saved against it.
 *
 * @param include Which records can represent a name, matching the `.filter()` each call site used
 * to do itself. A name whose records all fail it is left out entirely. Where several share a name,
 * a passing record is preferred over a failing one - a device that has just re-registered has an
 * entry with no settings replies in it yet, and that one must not stand in for the entry that has
 * them. Addresses are still collected from every record, passing or not, so a saved action holding
 * any of them stays matched.
 */
export function devicesByName(
	self: DanteInstance,
	include: (device: DeviceData) => boolean = () => true,
): NamedDevice[] {
	const byName = new Map<string, NamedDevice>()

	for (const [ip, device] of Object.entries(self.devicesData)) {
		// An unnamed device has no id to build an option from - `<prefix>_undefined` is nobody's field.
		if (device.name === undefined) continue

		const existing = byName.get(device.name)
		if (!existing) {
			byName.set(device.name, { name: device.name, device, ips: [ip] })
			continue
		}

		existing.ips.push(ip)
		if (include(device) && !include(existing.device)) existing.device = device
	}

	return [...byName.values()].filter((named) => include(named.device))
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

	// Choices are keyed by name and one name can reach us from two addresses (see `devicesByName`),
	// so this can be the second registration of a name already offered - pushing again would put two
	// entries with the same id in the dropdown. `updateDeviceChoice` guards the same way.
	if (self.devicesChoices.some((choice) => choice.id === deviceName)) return

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
	const device = self.devicesData[deviceIp]
	const ioObject = channelType === 'tx' ? device?.audioTx : device?.audioRx
	if (!ioObject) {
		logger.error("ERROR : Can't update channelsChoices for device " + deviceIp)
		return
	}

	const deviceName = device?.name
	if (deviceName === undefined) return

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
 * As {@link updateChannelChoices}, for a device's video channels.
 *
 * Kept separate rather than folded into one function taking a `ChannelMediaType`: the underlying
 * data comes from a differently-shaped source (`videoRx`/`videoTx`, populated by `parseAvReply`,
 * versus `rx`/`tx` populated by the legacy protocol) with its own field names (`VideoRxChannel` has
 * no `friendlyName`), so there is little left to share once that's accounted for.
 */
export function updateVideoChannelChoices(self: DanteInstance, deviceIp: string, channelType: 'tx' | 'rx'): void {
	const videoChannelType = channelType === 'tx' ? 'videoTx' : 'videoRx'
	if (!self.devicesData[deviceIp]?.[videoChannelType]) {
		logger.error("ERROR : Can't update video channelsChoices for device " + deviceIp)
		return
	}

	const deviceName = self.devicesData[deviceIp].name
	if (deviceName === undefined) return
	const ioObject = self.devicesData[deviceIp][videoChannelType]
	if (ioObject === undefined) return

	// No "None" entry - see the note in updateChannelChoices.
	const channelChoice: DropdownChoice<number>[] = []
	const choicesByDevice = channelType === 'tx' ? self.videoTxChannelsChoices : self.videoRxChannelsChoices
	for (let i = 1; i <= (ioObject.count ?? 0); i++) {
		channelChoice.push({ id: i, label: ioObject[i]?.name ?? '' })
	}

	const existing = choicesByDevice[deviceName]
	const changed =
		!existing ||
		existing.length !== channelChoice.length ||
		channelChoice.some((choice, index) => choice.label !== existing[index]?.label)
	if (changed) {
		logChannelNameChanges(deviceName, channelType, existing, channelChoice, 'video')
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
	mediaLabel: 'video' | undefined = undefined,
): void {
	const direction = `${mediaLabel ? `${mediaLabel} ` : ''}${channelType === 'tx' ? 'transmit' : 'receive'}`

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
