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
	channelsAreSettling,
	deviceByIdentifier,
	getChannelSubscriptionName,
	hasAudioRxChannels,
	hasAudioTxChannels,
	hasVideoRxChannels,
	hasVideoTxChannels,
	scheduleUpdateData,
} from './devices.js'
import { sanitiseVariableId } from '../utils/sanitise.js'

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
 * What a device has to offer in one direction, as a suffix for its dropdown label: ` (A)`, ` (V)`
 * or ` (AV)`.
 *
 * These pickers are shared by both media types and cannot be narrowed by the Channel Type selected
 * beside them, so a list of bare names says nothing about which entries can serve the type in hand -
 * the user picks a device, no channel picker appears, and only then does a warning explain why.
 * The tag moves that answer to where the choice is made.
 *
 * Per direction, not per device: an encoder with video transmit channels and audio *receive* ones
 * is `(V)` in a source list, because video is all it can be a source of.
 */
function mediaTag(device: DeviceData | undefined, direction: 'rx' | 'tx'): string {
	const hasAudio = direction === 'rx' ? hasAudioRxChannels(device) : hasAudioTxChannels(device)
	const hasVideo = direction === 'rx' ? hasVideoRxChannels(device) : hasVideoTxChannels(device)

	if (hasAudio && hasVideo) return ' (AV)'
	if (hasVideo) return ' (V)'
	if (hasAudio) return ' (A)'
	return ''
}

/**
 * Devices that have channels in one direction, as dropdown choices tagged with what they carry.
 *
 * Audio or video: the picker is shared by both (see {@link CHANNEL_MEDIA_TYPES}), and a device with
 * only one of the two must still appear so its channels are reachable once that type is selected.
 *
 * The id stays the bare device name - it is what actions store and what `deviceByIdentifier`
 * resolves - so the tag is on the label alone and an action saved before it existed is unaffected.
 */
function mediaTaggedDeviceChoices(
	self: DanteInstance,
	direction: 'rx' | 'tx',
	emptyLabel: string,
): DropdownChoice<string>[] {
	const choices: DropdownChoice<string>[] = []

	for (const choice of self.devicesChoices) {
		const tag = mediaTag(deviceByIdentifier(self, String(choice.id)), direction)
		if (tag === '') continue
		choices.push({ id: choice.id, label: `${choice.label}${tag}` })
	}

	return orPlaceholder(choices, emptyLabel)
}

/** Devices that have receive channels, as dropdown choices. See {@link mediaTaggedDeviceChoices}. */
export function rxDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return mediaTaggedDeviceChoices(self, 'rx', 'No devices with receive channels found')
}

/** Devices that have transmit channels, as dropdown choices. See {@link mediaTaggedDeviceChoices}. */
export function txDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return mediaTaggedDeviceChoices(self, 'tx', 'No devices with transmit channels found')
}

/**
 * Devices with audio receive channels, as dropdown choices.
 *
 * Narrower than both lists above, for the settings that exist per audio input and nowhere else -
 * output level is the one. {@link rxDeviceChoices} would offer a decoder whose only inputs are
 * video, and {@link audioDeviceChoices} a transmit-only device: either leaves a picker with a
 * device selected, no channel to pick, and nothing saying why.
 */
export function audioRxDeviceChoices(self: DanteInstance): DropdownChoice<string>[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => hasAudioRxChannels(deviceByIdentifier(self, String(choice.id)))),
		'No devices with audio receive channels found',
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
				// Sanitised, because a device name may hold characters an option id cannot - see
				// deviceOptionValue, which reads these keys back the same way.
				id: `${channelOptionPrefix(basePrefix, mediaType)}_${sanitiseVariableId(name)}` as Key,
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
				id: `${devicePickerId}No${mediaLabel}${direction.toUpperCase()}Channels_${sanitiseVariableId(name)}`,
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
 * Reads a per-device option, accepting every key form one may have been saved under.
 *
 * Fields are declared keyed by the *sanitised* device name, so that is tried first and a re-saved
 * action always uses the current key. Three older forms are still accepted behind it:
 *
 * - the unsanitised name, which is what a config saved before ids were sanitised holds;
 * - the identifier the option actually stores, sanitised - the device dropdown holds a name, and
 *   when that device is offline `deviceByIdentifier` cannot resolve it to look the name up;
 * - that identifier raw, which covers both an unsanitised name and an action saved before devices
 *   were keyed by name at all, whose key is suffixed with an address.
 *
 * Order matters only where the forms differ; for a device whose name needs no sanitising, and for
 * an address (sanitising leaves IPv4 untouched), several of these are the same key.
 */
export function deviceOptionValue<T>(
	self: DanteInstance,
	options: Record<string, unknown>,
	prefix: string,
	identifier: string,
	fallback: T,
): T {
	const name = deviceByIdentifier(self, identifier)?.name
	const suffixes = [
		...(name !== undefined ? [sanitiseVariableId(name), name] : []),
		sanitiseVariableId(identifier),
		identifier,
	]

	for (const suffix of suffixes) {
		// A null check rather than a truthiness test: 0 is a real value here - it is the channel
		// number that clears a crosspoint - and must not fall through to the next key.
		const stored = options[`${prefix}_${suffix}`]
		if (stored !== undefined && stored !== null) return stored as T
	}

	return fallback
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
		logChannelNameChanges(deviceName, channelType, existing, channelChoice, channelsAreSettling(self, deviceIp))
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
		logChannelNameChanges(
			deviceName,
			channelType,
			existing,
			channelChoice,
			channelsAreSettling(self, deviceIp),
			'video',
		)
		choicesByDevice[deviceName] = channelChoice
		scheduleUpdateData(self)
	}
}

/**
 * Reports channel renames at info, and a device's channel list being filled in at debug.
 *
 * A channel name is what every crosspoint action and feedback is stored against, so a rename can
 * quietly break a whole page of buttons - the same reason a device rename is worth an info line.
 * Filling the list in is not a rename, and there is a lot of it: the very first reply, every page
 * after the first (a channel not in the page just parsed has an empty name until its own page
 * arrives), and the transmit friendly names that supersede the plain names a reply or two earlier.
 * All of it would otherwise read as one rename line per channel on every connect.
 *
 * Three things separate the fill from a rename, and all three are needed - `settling` alone leaves
 * a slow reply logging nonsense, and the empty-name test alone cannot tell a friendly name from a
 * rename:
 *
 * - no previous list at all, so nothing can have changed;
 * - `settling`, meaning the module asked this device for its channels moments ago and these replies
 *   are the answer - see `markChannelsSettling`;
 * - a name appearing where there was none, which is a channel being learned whenever it happens.
 */
function logChannelNameChanges(
	deviceName: string,
	channelType: 'tx' | 'rx',
	existing: DropdownChoice<number>[] | undefined,
	incoming: DropdownChoice<number>[],
	settling: boolean,
	mediaLabel: 'video' | undefined = undefined,
): void {
	const direction = `${mediaLabel ? `${mediaLabel} ` : ''}${channelType === 'tx' ? 'transmit' : 'receive'}`

	if (!existing) {
		logger.debug(`${deviceName}: learned ${incoming.length} ${direction} channel(s)`)
		return
	}

	if (existing.length !== incoming.length) {
		const countLine = `${deviceName}: ${direction} channel count changed from ${existing.length} to ${incoming.length}`
		if (settling) logger.debug(countLine)
		else logger.info(countLine)
	}

	for (const [index, choice] of incoming.entries()) {
		const before = existing[index]
		// only channels that were already there can have been renamed; the rest are new
		if (before === undefined || before.label === choice.label) continue

		const line = `${deviceName} ${direction} channel ${choice.id} renamed: '${before.label}' -> '${choice.label}'`
		if (settling || before.label === '') logger.debug(line)
		else logger.info(line)
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
