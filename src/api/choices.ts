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
import { deviceIdForName, rememberTxChannelNames } from './identity.js'
import { channelDisplayLabel } from './protocol-rules.js'
import {
	brandedEntries,
	brandedKeys,
	channelNumbers,
	asDeviceName,
	isDanteDeviceId,
	type ChannelNumber,
	type DanteDeviceId,
	type DeviceIp,
	type DeviceName,
} from './ids.js'

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

/**
 * Channel choices as a dropdown shows them: each labelled by `channelDisplayLabel`, ids untouched.
 *
 * The stored lists keep the channel names themselves, because they are also the remembered names
 * subscriptions are resolved against (see `rememberedTxChannelNumber`) - so the display label is
 * applied here, where a list becomes a field, and nowhere earlier.
 */
export function displayChannelChoices(choices: DropdownChoice<ChannelNumber>[]): DropdownChoice<ChannelNumber>[] {
	return choices.map((choice) => ({ id: choice.id, label: channelDisplayLabel(choice.label, choice.id) }))
}

/** A device's rx or tx audio channel choices, or an empty list if it has none yet. */
export function audioChannelChoices(
	self: DanteInstance,
	device: DeviceData,
	channelType: 'rx' | 'tx',
): DropdownChoice<ChannelNumber>[] {
	if (!device.name) return []
	if (!device.id) return []
	const byDevice = channelType === 'rx' ? self.rxChannelsChoices : self.txChannelsChoices
	return byDevice[device.id] ?? []
}

/** A device's rx or tx video channel choices, or an empty list if it has none yet. */
export function videoChannelChoices(
	self: DanteInstance,
	device: DeviceData,
	channelType: 'rx' | 'tx',
): DropdownChoice<ChannelNumber>[] {
	if (!device.id) return []
	// The ?? {} guards a DanteInstance-like test double that predates video and so has no reason to
	// set this field - a real instance always has it, initialized alongside rxChannelsChoices.
	const byDevice = (channelType === 'rx' ? self.videoRxChannelsChoices : self.videoTxChannelsChoices) ?? {}
	return byDevice[device.id] ?? []
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
): DropdownChoice<ChannelNumber>[] {
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
/**
 * Every device a per-device channel field should be built for: those on the network now, plus any
 * whose channels are still remembered from before it went away.
 *
 * A per-device field exists only while its device has channels, so a device dropping out took its
 * option id out of the definition - and an option id that is not in the definition loses the value
 * stored against it. A device that blipped for one poll therefore came back with the channel
 * selection on every action and feedback pointing at it silently emptied, which reads as the module
 * having forgotten the device's channels. On a network where devices send no heartbeats, and mDNS is
 * the only thing keeping them alive, that blip needs nothing more than three dropped responses.
 *
 * So the choice lists outlive the device record (`destroyDevice` no longer clears them) and this
 * keeps emitting fields for what they remember. The device itself is still dropped from the device
 * *dropdown*, so it cannot be picked for something new while it is away - this only preserves the
 * fields that existing configuration already depends on.
 *
 * The stand-in carries just a name, which is all `mediaChannelChoices` reads, and no addresses -
 * a saved action holding an address instead of a name is matched by the arms
 * `deviceSelectedExpression` builds from the live record, which exists again the moment it returns.
 */
export function channelFieldDevices(self: DanteInstance): NamedDevice[] {
	const live = devicesById(self)
	const seen = new Set(live.map((named) => named.id))

	const remembered: NamedDevice[] = []
	for (const byDevice of [
		self.rxChannelsChoices,
		self.txChannelsChoices,
		self.videoRxChannelsChoices ?? {},
		self.videoTxChannelsChoices ?? {},
	]) {
		for (const id of brandedKeys(byDevice)) {
			if (seen.has(id)) continue
			seen.add(id)
			const name = self.deviceNamesById?.[id] ?? asDeviceName(id)
			remembered.push({ id, name, device: { id, name }, ips: [] })
		}
	}

	return [...live, ...remembered]
}

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
		for (const { id, name, device, ips } of channelFieldDevices(self)) {
			const choices = displayChannelChoices(mediaChannelChoices(self, device, direction, mediaType))
			if (choices.length === 0) continue

			// deviceSelectedExpression contains `||`, which binds looser than `&&` - bracket it (and, if
			// there's an extraVisibleCondition too, the whole device+type clause) so a later `&&` can't
			// silently swallow one arm of the `||`.
			const deviceAndType = `(${deviceSelectedExpression(devicePickerId, id, name, ...ips)}) && $(options:channelType) == '${mediaType}'`
			const isVisibleExpression = extraVisibleCondition
				? `(${deviceAndType}) && ${extraVisibleCondition}`
				: deviceAndType

			fields.push({
				type: 'dropdown',
				label: mediaType === 'audio' ? label : `${CHANNEL_MEDIA_TYPE_LABELS[mediaType]} ${label.toLowerCase()}`,
				// Keyed by device id, so a rename leaves every saved selection in place. deviceOptionValue
				// also reads the name-keyed ids 2.x saved under.
				id: `${channelOptionPrefix(basePrefix, mediaType)}_${id}` as Key,
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

/**
 * A transmit channel's name as last reported, read from the retained choice lists.
 *
 * The choice lists outlive a device's record (see `channelFieldDevices`), so they still hold a
 * channel's name while the device itself is not currently reporting. That matters for the crosspoint
 * feedbacks: a destination names its source by *channel name*, and matching that against a selected
 * channel *number* needs the source device's own directory - which is exactly what is missing when
 * the source has gone quiet. Without this the feedback reads false on a route the destination is
 * still reporting as made.
 *
 * Deliberately name resolution only. Whether a subscription is healthy is the destination's to
 * report, and nothing here may stand in for it.
 */
export function rememberedTxChannelName(
	self: DanteInstance,
	deviceIdentifier: string | undefined,
	mediaType: ChannelMediaType,
	channelNumber: number | string,
): string | undefined {
	const id = rememberedDeviceId(self, deviceIdentifier)
	if (id === undefined) return undefined
	const byDevice = (mediaType === 'video' ? self.videoTxChannelsChoices : self.txChannelsChoices) ?? {}
	const label = byDevice[id]?.find((choice) => String(choice.id) === String(channelNumber))?.label
	return label || undefined
}

/**
 * The name a device identifier refers to, including for a device that is offline: its current name
 * when online, otherwise the name its id was last seen with. Undefined when neither is known.
 */
export function rememberedDeviceName(
	self: DanteInstance,
	deviceIdentifier: string | undefined,
): DeviceName | undefined {
	const online = deviceByIdentifier(self, deviceIdentifier)?.name
	if (online !== undefined) return online
	const id = rememberedDeviceId(self, deviceIdentifier)
	return id !== undefined ? self.deviceNamesById?.[id] : undefined
}

/**
 * The id behind a device identifier, including for a device that is offline: an id is itself, and a
 * name - current or former, or as saved by 2.x - is looked up among the names ids have been seen
 * with. Addresses only resolve while the device is online.
 */
export function rememberedDeviceId(
	self: DanteInstance,
	deviceIdentifier: string | undefined,
): DanteDeviceId | undefined {
	if (deviceIdentifier === undefined) return undefined
	if (isDanteDeviceId(deviceIdentifier)) return deviceIdentifier
	return deviceByIdentifier(self, deviceIdentifier)?.id ?? deviceIdForName(self, deviceIdentifier)
}

/** The reverse of {@link rememberedTxChannelName}: a transmit channel's number, given its name. */
export function rememberedTxChannelNumber(
	self: DanteInstance,
	deviceIdentifier: string | undefined,
	mediaType: ChannelMediaType,
	channelName: string | undefined,
): ChannelNumber | undefined {
	const id = rememberedDeviceId(self, deviceIdentifier)
	if (id === undefined || channelName === undefined) return undefined
	const byDevice = (mediaType === 'video' ? self.videoTxChannelsChoices : self.txChannelsChoices) ?? {}
	return byDevice[id]?.find((choice) => choice.label === channelName)?.id
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
		// the same set perDeviceChannelFields builds from, so every device with a picker for one media
		// type has an explanation for the type it lacks
		for (const { id, name, device, ips } of channelFieldDevices(self)) {
			if (mediaChannelChoices(self, device, direction, mediaType).length > 0) continue
			const offeredAtAll = CHANNEL_MEDIA_TYPES.some(
				(otherType) => mediaChannelChoices(self, device, direction, otherType).length > 0,
			)
			if (!offeredAtAll) continue

			// Bracketed exactly as in perDeviceChannelFields: deviceSelectedExpression contains `||`,
			// which binds looser than the `&&` joining it to the channel-type test.
			const isVisibleExpression = `(${deviceSelectedExpression(devicePickerId, id, name, ...ips)}) && $(options:channelType) == '${mediaType}'`

			const mediaLabel = CHANNEL_MEDIA_TYPE_LABELS[mediaType]
			fields.push({
				type: 'static-text',
				// Not `channelOptionPrefix`: these hold no value, so there is no saved-config
				// compatibility to preserve and every media type can carry its own name.
				id: `${devicePickerId}No${mediaLabel}${direction.toUpperCase()}Channels_${id}`,
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
 * Matches the device id, which pickers store, and the device's current name and addresses, which
 * pickers saved by 2.x and 1.x hold - without those arms such an action shows no per-device field
 * at all, since nothing would match.
 */
export function deviceSelectedExpression(pickerId: string, ...values: string[]): string {
	return [...new Set(values)].map((value) => `$(options:${pickerId}) == '${value}'`).join(' || ')
}

/** One device, as the per-device option builders see it: its id and name, its record, its addresses. */
export interface NamedDevice {
	id: DanteDeviceId
	name: DeviceName
	device: DeviceData
	ips: DeviceIp[]
}

/**
 * The devices to build per-device option fields from: one entry per device id, for every online
 * device whose id is known.
 *
 * `devicesData` is keyed by address, and two addresses can carry one device - a device whose address
 * changed re-registers under the new one while the old record waits out its offline timeout, and a
 * Companion host on both a primary and a secondary Dante network sees one device from each. Grouping
 * by id gives each device one set of fields; every address is kept in `ips` so the visibility
 * expression still matches actions saved against any of them.
 *
 * @param include Which records can represent a device, matching the `.filter()` each call site used
 * to do itself. A device whose records all fail it is left out. Where several records share an id,
 * a passing one is preferred - a device that has just re-registered has a record with no settings
 * replies in it yet, and that one must not stand in for the record that has them.
 */
export function devicesById(self: DanteInstance, include: (device: DeviceData) => boolean = () => true): NamedDevice[] {
	const byId = new Map<DanteDeviceId, NamedDevice>()

	for (const [ip, device] of brandedEntries(self.devicesData)) {
		// Without an id there is nothing stable to key an option on, and without a name nothing to show.
		if (device.id === undefined || device.name === undefined) continue

		const existing = byId.get(device.id)
		if (!existing) {
			byId.set(device.id, { id: device.id, name: device.name, device, ips: [ip] })
			continue
		}

		existing.ips.push(ip)
		if (include(device) && !include(existing.device)) {
			existing.device = device
			existing.name = device.name
		}
	}

	return [...byId.values()].filter((named) => include(named.device))
}

/**
 * Reads a per-device option, accepting every key form one may have been saved under.
 *
 * Fields are keyed by device id, so that is tried first and an action saved by 3.x always uses it.
 * The forms 2.x and earlier saved are accepted behind it: the sanitised and the raw device name,
 * and the identifier the device option holds, sanitised and raw - a name, or an address from
 * before devices were keyed by name.
 */
export function deviceOptionValue<T>(
	self: DanteInstance,
	options: Record<string, unknown>,
	prefix: string,
	identifier: string,
	fallback: T,
): T {
	const device = deviceByIdentifier(self, identifier)
	const id = device?.id ?? rememberedDeviceId(self, identifier)
	const name = device?.name ?? (id !== undefined ? self.deviceNamesById?.[id] : undefined)
	const suffixes = new Set([
		...(id !== undefined ? [id] : []),
		...(name !== undefined ? [sanitiseVariableId(name), name] : []),
		sanitiseVariableId(identifier),
		identifier,
	])

	for (const suffix of suffixes) {
		// A null check rather than a truthiness test: 0 is a real value here - it is the channel
		// number that clears a crosspoint - and must not fall through to the next key.
		const stored = options[`${prefix}_${suffix}`]
		if (stored !== undefined && stored !== null) return stored as T
	}

	return fallback
}

/**
 * Rebuilds the device dropdown from the device records: one entry per online device whose id is
 * known, labelled with its name, sorted by label. Returns whether it changed.
 *
 * Derived rather than patched on each event, so a rename, an address change or a duplicate
 * announcement can never leave a stale or doubled entry behind.
 */
export function refreshDeviceChoices(self: DanteInstance): boolean {
	const next = devicesById(self)
		.map(({ id, name }) => ({ id, label: name }))
		.sort((a, b) => a.label.localeCompare(b.label))

	const current = self.devicesChoices
	const unchanged =
		current.length === next.length &&
		next.every((choice, index) => current[index]?.id === choice.id && current[index]?.label === choice.label)
	if (unchanged) return false

	self.devicesChoices = next
	scheduleUpdateData(self)
	return true
}

/**
 * Records a device's new name and rebuilds the device dropdown. The record must still hold the
 * outgoing name when this is called, for the log line.
 */
export function updateDeviceChoice(self: DanteInstance, deviceIp: DeviceIp, newName: DeviceName): void {
	const device = self.devicesData[deviceIp]
	const previousName = device?.name

	// With choices keyed by id a rename no longer breaks the actions pointing at the device, but it
	// does break any route other devices made to it by name - Dante subscribes by name.
	if (previousName && previousName !== newName) {
		logger.info(`Device renamed: '${previousName}' is now '${newName}' (${deviceIp})`)
	} else if (self.debug) {
		logger.debug(`Device name for ${deviceIp} confirmed as '${newName}'`)
	}

	if (device) {
		device.name = newName
		const id = self.deviceIdsByName?.[newName] ?? device.id
		if (id !== undefined) noteDeviceName(self, id, newName)
	}
	refreshDeviceChoices(self)
}

/** Remembers the name a device id was last seen with, for while the device is offline. */
export function noteDeviceName(self: DanteInstance, id: DanteDeviceId, name: DeviceName): void {
	;(self.deviceNamesById ??= {})[id] = name
	;(self.deviceIdsByName ??= {})[name] = id
}

/**
 * Creates or updates the tx/rx channel-name dropdown choices for a device, rebuilding
 * action/feedback/variable definitions if anything changed.
 */
export function updateChannelChoices(self: DanteInstance, deviceIp: DeviceIp, channelType: 'tx' | 'rx'): void {
	const device = self.devicesData[deviceIp]
	const ioObject = channelType === 'tx' ? device?.audioTx : device?.audioRx
	if (!ioObject) {
		logger.error("ERROR : Can't update channelsChoices for device " + deviceIp)
		return
	}

	const deviceName = device?.name
	const deviceId = device?.id
	// Channel choices are keyed by id; this runs again for the device once its id arrives
	if (deviceName === undefined || deviceId === undefined) return
	if (channelType === 'tx') rememberTxChannelNames(self, deviceIp)

	// No "None" entry: every action taking a channel acts on that one channel, so a "none" selection
	// only means "do nothing". It also sorted first, which made it the default - so a freshly added
	// action silently did nothing until a channel was picked.
	const channelChoice: DropdownChoice<ChannelNumber>[] = []
	const choicesByDevice = channelType === 'tx' ? self.txChannelsChoices : self.rxChannelsChoices
	for (const number of channelNumbers(ioObject.count)) {
		const channelName =
			channelType === 'tx' ? (getChannelSubscriptionName(ioObject[number]) ?? '') : (ioObject[number]?.name ?? '')
		channelChoice.push({ id: number, label: channelName })
	}

	const existing = choicesByDevice[deviceId]
	const changed =
		!existing ||
		existing.length !== channelChoice.length ||
		channelChoice.some((choice, index) => choice.label !== existing[index]?.label)
	if (changed) {
		logChannelNameChanges(deviceName, channelType, existing, channelChoice, channelsAreSettling(self, deviceIp))
		choicesByDevice[deviceId] = channelChoice
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
export function updateVideoChannelChoices(self: DanteInstance, deviceIp: DeviceIp, channelType: 'tx' | 'rx'): void {
	const videoChannelType = channelType === 'tx' ? 'videoTx' : 'videoRx'
	if (!self.devicesData[deviceIp]?.[videoChannelType]) {
		logger.error("ERROR : Can't update video channelsChoices for device " + deviceIp)
		return
	}

	const deviceName = self.devicesData[deviceIp].name
	const deviceId = self.devicesData[deviceIp].id
	if (deviceName === undefined || deviceId === undefined) return
	if (channelType === 'tx') rememberTxChannelNames(self, deviceIp)
	const ioObject = self.devicesData[deviceIp][videoChannelType]
	if (ioObject === undefined) return

	// No "None" entry - see the note in updateChannelChoices.
	const channelChoice: DropdownChoice<ChannelNumber>[] = []
	const choicesByDevice = channelType === 'tx' ? self.videoTxChannelsChoices : self.videoRxChannelsChoices
	for (const number of channelNumbers(ioObject.count)) {
		channelChoice.push({ id: number, label: ioObject[number]?.name ?? '' })
	}

	const existing = choicesByDevice[deviceId]
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
		choicesByDevice[deviceId] = channelChoice
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
