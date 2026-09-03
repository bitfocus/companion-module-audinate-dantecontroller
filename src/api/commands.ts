/**
 * Commands that change something on a device.
 */

import { DANTE_CONST } from './const.js'
import { validateDanteName } from './protocol-rules.js'
import { Regex, createModuleLogger } from '@companion-module/base'
import type DanteInstance from '../main.js'
import { intToBuffer, makeAvCommand, makeCommand, makeSettingCommand } from './protocol.js'
import { sendCommand } from './connection.js'
import {
	deviceByIdentifier,
	deviceLabel,
	findAudioRxChannelByName,
	findAudioTxChannelByName,
	findDeviceIpByName,
	findVideoRxChannelByName,
	getChannelSubscriptionName,
} from './devices.js'
import { getVideoRxChannels, getVideoTxChannels } from './queries.js'

const logger = createModuleLogger('api:commands')

/** Resets a device's name back to its factory default. */
export function resetDeviceName(self: DanteInstance, ipaddress: string): void {
	logCommand(self, deviceLabel(self, ipaddress), 'reset device name to factory default')
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.setDeviceName)
	sendCommand(self, commandBuffer, ipaddress)
}

/** Sets a device's name. */
export function setDeviceName(self: DanteInstance, ipaddress: string, name: string): void {
	const invalid = validateDanteName(name)
	if (invalid) {
		logger.error(`Device name '${name}' ${invalid}`)
		return
	}
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.setDeviceName, Buffer.from(name, 'ascii'))
	sendCommand(self, commandBuffer, ipaddress)
}

/**
 * Rejects a channel number that identifies no channel.
 *
 * Channel dropdowns used to offer a "None" entry with the id 0, and it was the default - so an
 * action saved without picking a channel still carries it. Nothing can be done with channel 0, and
 * failing loudly beats the silent no-op it used to be.
 */
/**
 * Records a control command the module is issuing, when verbose logging is on.
 *
 * Distinct from the route and rename lines logged at info: those report what a device says its
 * state *is*, which is the thing worth knowing normally. This reports what the module asked for,
 * which only matters when the two disagree - a command rejected by a locked device, or one that
 * never arrived.
 */
function logCommand(self: DanteInstance, target: string, what: string): void {
	if (!self.debug) return
	logger.debug(`Command -> ${target} : ${what}`)
}

function hasChannel(channelNumber: number, what: string): boolean {
	if (channelNumber > 0) return true
	logger.error(`No channel selected for ${what} - pick one in the action's Channel dropdown`)
	return false
}

/** Sets the name of an rx or tx channel on a device. */
export function setChannelName(
	self: DanteInstance,
	ipaddress: string,
	channelName = '',
	channelType: 'rx' | 'tx' = 'rx',
	channelNumber = 0,
): void {
	if (!hasChannel(channelNumber, 'channel rename')) return

	// An empty name is how the reset actions ask for the factory default, so it stays allowed.
	const invalid = validateDanteName(channelName, { allowColon: true })
	if (invalid) {
		logger.error(`Channel name '${channelName}' ${invalid}`)
		return
	}
	const channelNameBuffer = Buffer.from(channelName, 'ascii')
	const channelNumberBuffer = intToBuffer(channelNumber)

	let commandBuffer: Buffer
	if (channelType === 'rx') {
		const commandArguments = Buffer.concat([
			Buffer.from('0401', 'hex'),
			channelNumberBuffer,
			Buffer.from('001c', 'hex'),
			Buffer.alloc(12),
			channelNameBuffer,
		])
		commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CONTROL, commandArguments)
	} else if (channelType === 'tx') {
		const commandArguments = Buffer.concat([
			// see the note in setAudioTxChannelName - 4 bytes, matching the 0x0024 pointer below
			Buffer.from('04010000', 'hex'),
			channelNumberBuffer,
			Buffer.from('0024', 'hex'),
			Buffer.alloc(18),
			channelNameBuffer,
		])
		commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_NAMES_CONTROL, commandArguments)
	} else {
		throw new Error("Invalid Channel Type - must be 'tx' or 'rx'")
	}
	sendCommand(self, commandBuffer, ipaddress)
}

/** Sets the name of an rx channel on a device. */
export function setAudioRxChannelName(
	self: DanteInstance,
	ipaddress: string,
	channelNumber: number,
	channelName = '',
): void {
	if (!hasChannel(channelNumber, 'channel rename')) return

	// An empty name is how the reset actions ask for the factory default, so it stays allowed.
	const invalid = validateDanteName(channelName, { allowColon: true })
	if (invalid) {
		logger.error(`Channel name '${channelName}' ${invalid}`)
		return
	}
	const channelNameBuffer = Buffer.from(channelName, 'ascii')
	const channelNumberBuffer = intToBuffer(channelNumber)

	const commandArguments = Buffer.concat([
		Buffer.from('0401', 'hex'),
		channelNumberBuffer,
		Buffer.from('001c', 'hex'),
		Buffer.alloc(12),
		channelNameBuffer,
	])
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CONTROL, commandArguments)
	sendCommand(self, commandBuffer, ipaddress)
}

/** Sets the name of a tx channel on a device. */
export function setAudioTxChannelName(
	self: DanteInstance,
	ipaddress: string,
	channelNumber: number,
	channelName = '',
): void {
	if (!hasChannel(channelNumber, 'channel rename')) return

	// An empty name is how the reset actions ask for the factory default, so it stays allowed.
	const invalid = validateDanteName(channelName, { allowColon: true })
	if (invalid) {
		logger.error(`Channel name '${channelName}' ${invalid}`)
		return
	}
	const channelNameBuffer = Buffer.from(channelName, 'ascii')
	const channelNumberBuffer = intToBuffer(channelNumber)

	const commandArguments = Buffer.concat([
		// 4 bytes, and the width matters: it sets where the name string lands, which the 0x0024
		// pointer below has to match (10 header + 4 + 2 + 2 + 18 = 36 = 0x24). This was written as
		// the 9-character '040100000', which Node silently truncated to these same 4 bytes.
		Buffer.from('04010000', 'hex'),
		channelNumberBuffer,
		Buffer.from('0024', 'hex'),
		Buffer.alloc(18),
		channelNameBuffer,
	])
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_NAMES_CONTROL, commandArguments)

	sendCommand(self, commandBuffer, ipaddress)
}

/** Clears the name of an rx or tx channel on a device back to its default. */
export function resetChannelName(
	self: DanteInstance,
	ipaddress: string,
	channelType: 'rx' | 'tx' = 'rx',
	channelNumber = 0,
): void {
	setChannelName(self, ipaddress, '', channelType, channelNumber)
}

/** Clears the name of an rx channel on a device back to its default. */
export function resetAudioRxChannelName(self: DanteInstance, ipaddress: string, channelNumber = 0): void {
	setAudioRxChannelName(self, ipaddress, channelNumber)
}

/** Clears the name of a tx channel on a device back to its default. */
export function resetAudioTxChannelName(self: DanteInstance, ipaddress: string, channelNumber = 0): void {
	setAudioTxChannelName(self, ipaddress, channelNumber)
}

/**
 * Largest number of channels to unsubscribe in one command, so the packet stays comfortably inside
 * a single datagram on a device with a high channel count.
 */
const MAX_UNSUBSCRIBE_PER_COMMAND = 16

/**
 * Clears every rx channel subscription on a device.
 *
 * Uses the subscription-remove opcode, whose payload is simply a channel count followed by the
 * channel numbers - so a whole device clears in one packet rather than one per channel. Verified
 * against hardware, including removing several channels in a single command.
 *
 * Note the framing: the payload is `[count u32][channel u32]...` with no leading pad, and
 * `makeCommand`'s two zero request-flag bytes supply the high half of that first u32. Passing the
 * count as a u16 here is what makes the bytes line up; widening it would shift the whole payload.
 */
export function clearAllAudioCrosspoints(self: DanteInstance, destinationDevice: string): void {
	// Check if destinationDevice is an IP or a name
	const IP = RegExp(Regex.IP.slice(1, -1))
	const ipaddress = IP.test(destinationDevice) ? destinationDevice : findDeviceIpByName(self, destinationDevice)

	if (!ipaddress) {
		logger.error("Can't find " + destinationDevice + ' IP address')
		return
	}

	const rxCount = self.devicesData[ipaddress]?.audioRx?.count ?? 0
	if (rxCount < 1) {
		logger.warn(`${destinationDevice} has no known receive channels to clear`)
		return
	}

	const channels = Array.from({ length: rxCount }, (_, index) => index + 1)
	for (let offset = 0; offset < channels.length; offset += MAX_UNSUBSCRIBE_PER_COMMAND) {
		const batch = channels.slice(offset, offset + MAX_UNSUBSCRIBE_PER_COMMAND)
		const commandArguments = Buffer.concat([
			intToBuffer(batch.length),
			...batch.map((channel) => intToBuffer(channel, 4)),
		])
		const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.subscriptionRemove, commandArguments)
		sendCommand(self, commandBuffer, ipaddress)
	}

	logger.info(`Cleared all ${rxCount} receive channels on ${destinationDevice}`)
}

/**
 * Clears every video rx channel subscription on a device.
 *
 * One `clearVideoCrosspoint` call per channel rather than {@link clearAllAudioCrosspoints}'s batched
 * single packet: `MESSAGE_TYPE_AV_CROSSPOINT_CONTROL` supports batching several entries in one
 * command (confirmed in a real capture), but video-capable devices seen so far have very few
 * channels, so the simplicity of reusing the already-verified single-entry path outweighs adding
 * and testing an unneeded batched one.
 */
export function clearAllVideoCrosspoints(self: DanteInstance, destinationDevice: string): void {
	const videoRxCount = deviceByIdentifier(self, destinationDevice)?.videoRx?.count ?? 0
	if (videoRxCount < 1) {
		logger.warn(`${destinationDevice} has no known video receive channels to clear`)
		return
	}

	for (let channel = 1; channel <= videoRxCount; channel++) {
		clearVideoCrosspoint(self, destinationDevice, channel)
	}

	logger.info(`Cleared all ${videoRxCount} video receive channels on ${destinationDevice}`)
}

/** Subscribes a destination rx channel to a source tx channel, creating a Dante crosspoint. */

export function makeAudioCrosspoint(
	self: DanteInstance,
	destinationDevice: string,
	sourceChannelName: string,
	sourceDeviceName: string,
	destinationChannel: string | number,
): void {
	const sourceChannel = findAudioTxChannelByName(self, sourceDeviceName, sourceChannelName)
	const sourceSubscriptionName = getChannelSubscriptionName(sourceChannel) || sourceChannelName
	const sourceChannelNameBuffer = Buffer.from(sourceSubscriptionName, 'ascii')
	const sourceDeviceNameBuffer = Buffer.from(sourceDeviceName, 'ascii')

	const destinationChannelNumber =
		findAudioRxChannelByName(self, destinationDevice, String(destinationChannel))?.number ?? destinationChannel

	// Check if destinationDevice is an IP or a name
	const IP = RegExp(Regex.IP.slice(1, -1))
	const ipaddress = IP.test(destinationDevice) ? destinationDevice : findDeviceIpByName(self, destinationDevice)

	if (!ipaddress) {
		logger.error("Can't find " + destinationDevice + ' IP address')
		return
	}

	const commandArguments = Buffer.concat([
		Buffer.from('0001', 'hex'), // unknown code
		intToBuffer(Number(destinationChannelNumber)), // destination channel number
		intToBuffer(22), // Byte index of source channel Name
		intToBuffer(22 + sourceChannelNameBuffer.length + 1), // Byte index of source device name
		Buffer.alloc(4), // padding until byte index of source channel name
		sourceChannelNameBuffer, // source channel Name
		Buffer.alloc(1), // separator (\x00)
		sourceDeviceNameBuffer, // source device name
	])

	logCommand(
		self,
		`${destinationDevice} ch${destinationChannelNumber}`,
		`subscribe to ${sourceDeviceName} / ${sourceSubscriptionName}`,
	)

	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.subscription, commandArguments)

	sendCommand(self, commandBuffer, ipaddress)

	// get updated routing for feedback
	//		getRxChannels(self, ipaddress);
}

/** Unsubscribes a destination rx channel, clearing its Dante crosspoint. */
export function clearAudioCrosspoint(
	self: DanteInstance,
	destinationDevice: string,
	destinationChannel: string | number,
): void {
	const destinationChannelNumber =
		findAudioRxChannelByName(self, destinationDevice, String(destinationChannel))?.number ?? destinationChannel

	if (!hasChannel(Number(destinationChannelNumber), 'clear crosspoint')) return

	// Check if destinationDevice is an IP or a name
	const IP = RegExp(Regex.IP.slice(1, -1))
	const ipaddress = IP.test(destinationDevice) ? destinationDevice : findDeviceIpByName(self, destinationDevice)

	if (!ipaddress) {
		logger.error("Can't find " + destinationDevice + ' IP address')
		return
	}

	logCommand(self, `${destinationDevice} ch${destinationChannelNumber}`, 'clear subscription')

	const commandArguments = Buffer.concat([
		Buffer.from('0401', 'hex'),
		intToBuffer(Number(destinationChannelNumber)),
		Buffer.from('005c006d', 'hex'),
		Buffer.alloc(1),
	])

	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.subscription, commandArguments)

	sendCommand(self, commandBuffer, ipaddress)
}

/**
 * The fixed-size gap between a `MESSAGE_TYPE_AV_CROSSPOINT_CONTROL` command's two name pointers and
 * where the pointed-to strings actually start, confirmed against a real Dante-Controller-equivalent
 * capture (see the `dante-video-routing-protocol` project notes). Present whether or not the
 * pointers are actually used - a clear command is the same total length as one with an empty source.
 */
const VIDEO_CROSSPOINT_NAME_GAP = 16

/**
 * Builds one `MESSAGE_TYPE_AV_CROSSPOINT_CONTROL` entry: the fixed object/channel header, the two
 * source-name pointers (zeroed when `source` is omitted, which is how a video crosspoint is
 * cleared), and - only when setting - the two NUL-terminated name strings themselves.
 *
 * This module only ever sends one entry per command, unlike real Dante Controller traffic observed
 * batching several - simpler, and every crosspoint action already operates on one channel at a time.
 */
function makeVideoCrosspointArguments(
	destinationChannelNumber: number,
	source: { channelName: string; deviceName: string } | undefined,
): Buffer {
	const header = Buffer.concat([
		Buffer.alloc(6),
		intToBuffer(DANTE_CONST.AV_OBJECT_TAG.CROSSPOINT),
		Buffer.from([0x03, 0x01]), // fixed marker byte + entry count (always 1 - see above)
		intToBuffer(destinationChannelNumber),
		intToBuffer(DANTE_CONST.AV_MEDIA_TYPE.VIDEO),
	])

	if (!source) {
		return Buffer.concat([header, Buffer.alloc(4 + VIDEO_CROSSPOINT_NAME_GAP)])
	}

	const channelNameBuffer = Buffer.from(source.channelName, 'ascii')
	const deviceNameBuffer = Buffer.from(source.deviceName, 'ascii')
	// Pointers are absolute offsets from the start of the whole packet: the 10-byte AV command
	// header, this entry header, the two pointer fields themselves, then the fixed gap above.
	const pointerToChannelName = 10 + header.length + 4 + VIDEO_CROSSPOINT_NAME_GAP
	const pointerToDeviceName = pointerToChannelName + channelNameBuffer.length + 1

	return Buffer.concat([
		header,
		intToBuffer(pointerToChannelName),
		intToBuffer(pointerToDeviceName),
		Buffer.alloc(VIDEO_CROSSPOINT_NAME_GAP),
		channelNameBuffer,
		Buffer.alloc(1),
		deviceNameBuffer,
		Buffer.alloc(1),
	])
}

/**
 * Subscribes a destination video rx channel to a source video tx channel, using the `AV_EXTENDED`
 * protocol these AV-X-capable devices carry video routing over - there is no video crosspoint under
 * the plain `CONTROL` protocol {@link makeAudioCrosspoint} uses for audio.
 */
/**
 * Re-reads a device's video channel directory after a command that changed it.
 *
 * Audio needs no equivalent: Dante devices announce their own routing and naming changes over the
 * CONTROL protocol, and `parseReply` folds those announcements into `devicesData` as they arrive.
 * Nothing equivalent turns up for `AV_EXTENDED` video - the crosspoint acknowledgement carries no
 * state and no unsolicited update follows - so without this the module keeps serving the values it
 * read at discovery. The visible effect was a video route that had just been cleared still reading
 * as connected in `routing_bg` and `channel_subscription` until the next Refresh.
 *
 * Sent immediately rather than after a delay: the device applies the write before answering the
 * query, confirmed live by issuing the two back-to-back and reading the updated directory every
 * time, across repeated set/clear cycles.
 */
function refreshVideoChannels(self: DanteInstance, ipaddress: string, direction: 'rx' | 'tx'): void {
	if (direction === 'rx') getVideoRxChannels(self, ipaddress)
	else getVideoTxChannels(self, ipaddress)
}

export function makeVideoCrosspoint(
	self: DanteInstance,
	destinationDevice: string,
	sourceChannelName: string,
	sourceDeviceName: string,
	destinationChannel: string | number,
): void {
	const destinationChannelNumber =
		findVideoRxChannelByName(self, destinationDevice, String(destinationChannel))?.number ?? destinationChannel
	if (!hasChannel(Number(destinationChannelNumber), 'video crosspoint')) return

	const IP = RegExp(Regex.IP.slice(1, -1))
	const ipaddress = IP.test(destinationDevice) ? destinationDevice : findDeviceIpByName(self, destinationDevice)
	if (!ipaddress) {
		logger.error("Can't find " + destinationDevice + ' IP address')
		return
	}

	logCommand(
		self,
		`${destinationDevice} video ch${destinationChannelNumber}`,
		`subscribe to ${sourceDeviceName} / ${sourceChannelName}`,
	)

	const commandArguments = makeVideoCrosspointArguments(Number(destinationChannelNumber), {
		channelName: sourceChannelName,
		deviceName: sourceDeviceName,
	})
	const commandBuffer = makeAvCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_CROSSPOINT_CONTROL, commandArguments)
	sendCommand(self, commandBuffer, ipaddress)
	refreshVideoChannels(self, ipaddress, 'rx')
}

/** Unsubscribes a destination video rx channel, clearing its video crosspoint. */
export function clearVideoCrosspoint(
	self: DanteInstance,
	destinationDevice: string,
	destinationChannel: string | number,
): void {
	const destinationChannelNumber =
		findVideoRxChannelByName(self, destinationDevice, String(destinationChannel))?.number ?? destinationChannel
	if (!hasChannel(Number(destinationChannelNumber), 'clear video crosspoint')) return

	const IP = RegExp(Regex.IP.slice(1, -1))
	const ipaddress = IP.test(destinationDevice) ? destinationDevice : findDeviceIpByName(self, destinationDevice)
	if (!ipaddress) {
		logger.error("Can't find " + destinationDevice + ' IP address')
		return
	}

	logCommand(self, `${destinationDevice} video ch${destinationChannelNumber}`, 'clear video subscription')

	const commandArguments = makeVideoCrosspointArguments(Number(destinationChannelNumber), undefined)
	const commandBuffer = makeAvCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_CROSSPOINT_CONTROL, commandArguments)
	sendCommand(self, commandBuffer, ipaddress)
	refreshVideoChannels(self, ipaddress, 'rx')
}

/**
 * The fixed-size gap between a `*_NAME_CONTROL` command's one name pointer and where the pointed-to
 * string actually starts. Narrower than {@link VIDEO_CROSSPOINT_NAME_GAP} because there is only one
 * pointer field here rather than two - confirmed against a real capture, see `makeVideoCrosspoint`.
 */
const VIDEO_NAME_GAP = 12

/** Sets a video channel's own name, on either a tx or an rx device depending on `opcode`. */
function setVideoChannelName(
	self: DanteInstance,
	opcode: number,
	ipaddress: string,
	channelNumber: number,
	channelName: string,
): void {
	if (!hasChannel(channelNumber, 'video channel rename')) return

	// allowSpace: real hardware ships with (and accepted, live) names like "Decoder Video Channel" -
	// see the note on validateDanteName's allowSpace option.
	const invalid = validateDanteName(channelName, { allowSpace: true })
	if (invalid) {
		logger.error(`Channel name '${channelName}' ${invalid}`)
		return
	}

	const header = Buffer.concat([
		Buffer.alloc(6),
		intToBuffer(DANTE_CONST.AV_OBJECT_TAG.NAME),
		Buffer.from([0x03, 0x01]), // fixed marker byte + entry count, as in makeVideoCrosspointArguments
		intToBuffer(channelNumber),
		intToBuffer(DANTE_CONST.AV_MEDIA_TYPE.VIDEO),
	])
	const nameBuffer = Buffer.from(channelName, 'ascii')
	const pointerToName = 10 + header.length + 2 + VIDEO_NAME_GAP

	const commandArguments = Buffer.concat([
		header,
		intToBuffer(pointerToName),
		Buffer.alloc(VIDEO_NAME_GAP),
		nameBuffer,
		Buffer.alloc(1),
	])
	sendCommand(self, makeAvCommand(self, opcode, commandArguments), ipaddress)
	refreshVideoChannels(
		self,
		ipaddress,
		opcode === DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_NAME_CONTROL ? 'rx' : 'tx',
	)
}

/** Sets the name of a video rx channel on a device. */
export function setVideoRxChannelName(
	self: DanteInstance,
	ipaddress: string,
	channelNumber: number,
	channelName = '',
): void {
	setVideoChannelName(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_NAME_CONTROL,
		ipaddress,
		channelNumber,
		channelName,
	)
}

/** Sets the name of a video tx channel on a device. */
export function setVideoTxChannelName(
	self: DanteInstance,
	ipaddress: string,
	channelNumber: number,
	channelName = '',
): void {
	setVideoChannelName(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_NAME_CONTROL,
		ipaddress,
		channelNumber,
		channelName,
	)
}

/** Clears the name of a video rx channel on a device back to its default. */
export function resetVideoRxChannelName(self: DanteInstance, ipaddress: string, channelNumber = 0): void {
	setVideoRxChannelName(self, ipaddress, channelNumber)
}

/** Clears the name of a video tx channel on a device back to its default. */
export function resetVideoTxChannelName(self: DanteInstance, ipaddress: string, channelNumber = 0): void {
	setVideoTxChannelName(self, ipaddress, channelNumber)
}

/** Sets a device's link-offset latency. */
export function setLatency(self: DanteInstance, ipaddress: string, latency: number): void {
	logCommand(self, deviceLabel(self, ipaddress), `set latency to ${latency}ms`)
	const commandArguments = Buffer.from('050382050020021100108301002400000000000000000000000000000000', 'hex')
	commandArguments.writeUInt32BE(latency * 1000000, 22)
	commandArguments.writeUInt32BE(latency * 1000000, 26)
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_CONTROL, commandArguments)
	sendCommand(self, commandBuffer, ipaddress)
}

/**
 * Sets a device's sample rate. A `sampleRate` of 0 queries the current value instead of changing it
 * (see {@link getSampleRate}).
 */
export function setSampleRate(self: DanteInstance, ipaddress: string, sampleRate: number): void {
	// 0 is the query form of this command, not a rate anyone set
	logCommand(
		self,
		deviceLabel(self, ipaddress),
		sampleRate === 0 ? 'query sample rate' : `set sample rate to ${sampleRate}`,
	)
	const flag = intToBuffer(sampleRate > 0 ? 1 : 0, 4)
	const commandArguments = Buffer.concat([Buffer.from('00000064', 'hex'), flag, intToBuffer(sampleRate, 4)])
	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_CONTROL,
		commandArguments,
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Sets a device's sample rate pullup. */
export function setPullup(self: DanteInstance, ipaddress: string, pullup: number): void {
	logCommand(self, deviceLabel(self, ipaddress), `set sample rate pullup to ${pullup}`)
	const flag = intToBuffer(3, 4)
	const commandArguments = Buffer.concat([
		Buffer.from('00000064', 'hex'),
		flag,
		intToBuffer(pullup, 4),
		intToBuffer(0, 2),
	])
	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_PULLUP_CONTROL,
		commandArguments,
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/**
 * Sets a device's audio encoding (bit depth). An `encoding` of 0 queries the current value instead
 * of changing it (see {@link getEncoding}).
 */
export function setEncoding(self: DanteInstance, ipaddress: string, encoding: number): void {
	logCommand(self, deviceLabel(self, ipaddress), encoding === 0 ? 'query encoding' : `set encoding to ${encoding}`)
	const flag = intToBuffer(encoding > 0 ? 1 : 0, 4)
	const commandArguments = Buffer.concat([Buffer.from('00000064', 'hex'), flag, intToBuffer(encoding, 4)])

	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_ENCODING_CONTROL,
		commandArguments,
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Sets the output level for a channel on a device. */
export function setLevel(
	self: DanteInstance,
	ipaddress: string,
	_direction: 'out',
	channelNumber: number,
	levelSetting: number,
): void {
	if (!hasChannel(channelNumber, 'output level')) return

	const commandArguments = Buffer.concat([
		Buffer.from('00000000', 'hex'),
		Buffer.from('00010001', 'hex'),
		Buffer.from('000c0010', 'hex'),
		Buffer.from('02010000', 'hex'),
		intToBuffer(channelNumber, 4),
		intToBuffer(levelSetting, 4),
	])

	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_CONTROL,
		commandArguments,
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}
