/**
 * Reading and writing Dante wire format: byte helpers, command framing, and reply parsers.
 */

import { DANTE_CONST } from './const.js'
import { codeLabel, isSubscriptionConnected } from './protocol-rules.js'
import merge from '../utils/merge.js'
import { createModuleLogger } from '@companion-module/base'
import type dgram from 'node:dgram'
import type DanteInstance from '../main.js'
import type {
	DeviceData,
	AudioRxChannel,
	AudioRxChannels,
	AudioTxChannels,
	VideoRxChannels,
	VideoTxChannels,
} from './types.js'
import { updateChannelChoices, updateDeviceChoice, updateVideoChannelChoices } from './choices.js'
import {
	deviceLabel,
	keepAlive,
	macForDevice,
	scheduleCheckFeedbacks,
	scheduleCheckVariables,
	scheduleUpdateData,
} from './devices.js'
import {
	getRxChannels,
	getSettings,
	getTxChannelFriendlyNames,
	getTxChannels,
	getVideoRxChannels,
	getVideoTxChannels,
	refreshSettings,
} from './queries.js'

const logger = createModuleLogger('api:protocol')

function compareArrays(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

/** Encodes an integer into a big-endian byte buffer. */
export function intToBuffer(value: number, bytes: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 2): Buffer {
	const intBuffer = Buffer.alloc(bytes)
	switch (bytes) {
		case 1:
			intBuffer.writeInt8(value)
			break
		case 2:
		case 3:
			intBuffer.writeUInt16BE(value, bytes - 2)
			break
		case 4:
		case 5:
		case 6:
		case 7:
			intBuffer.writeUint32BE(value, bytes - 4)
			break
		case 8:
			intBuffer.writeBigUInt64BE(BigInt(value))
			break
	}

	return intBuffer
}

/** Decodes a big-endian integer from a byte buffer. */
export function bufferToInt(buffer: Buffer, offset = 0, bytes: 1 | 2 | 4 = 2): number {
	switch (bytes) {
		case 1:
			return buffer.readInt8(offset)
		case 2:
			return buffer.readUInt16BE(offset)
		case 4:
			return buffer.readUint32BE(offset)
	}
}

/** Increments a big-endian byte buffer in place by 1, carrying across bytes as needed. */
export function incrementBE(buffer: Buffer): void {
	for (let i = buffer.length - 1; i >= 0; i--) {
		if (buffer[i]++ !== 255) break
	}
}

/** Reads a NUL-terminated UTF-8 string out of a Dante message buffer. */
export function parseString(buffer: Buffer, startIndex: number): string | undefined {
	if (startIndex < 0 || startIndex >= buffer.length) {
		return undefined
	}
	const end = buffer.indexOf(0x00, startIndex)
	// An unterminated string runs to the end of the packet rather than yielding nothing
	return buffer.toString('utf8', startIndex, end === -1 ? buffer.length : end)
}

/**
 * Reads a string at an offset the packet itself supplies, treating a zero pointer as "absent".
 *
 * Records use a zero pointer for fields they have no value for - an unrouted rx channel has no
 * source device or channel, for instance. Dereferencing that reads from the start of the packet
 * and returns the protocol header as text, so those fields end up holding `')` and similar.
 */
export function parseStringAtPointer(buffer: Buffer, pointer: number): string | undefined {
	if (pointer === 0) {
		return undefined
	}
	return parseString(buffer, pointer)
}

//**
//** Dante messages parsing
//**

/** Parses a channel-count-query reply into tx/rx channel counts. */
function parseChannelCount(reply: Buffer): Partial<DeviceData> {
	// Offset 34 carries the device lock flag. A locked device silently ignores writes, so surfacing
	// it turns "my button does nothing" into something the user can actually see. Guard the read:
	// only longer replies carry the field.
	const locked = reply.length >= 36 ? reply.readUInt16BE(34) !== 0 : undefined
	return { audioTx: { count: reply[13] }, audioRx: { count: reply[15] }, locked }
}

/**
 * Reads a big-endian u32 at a pointer supplied by the device, returning undefined rather than
 * throwing when the pointer falls outside the packet.
 *
 * Channel records carry byte offsets into the reply. Those come off the wire, so a truncated or
 * malformed packet can point anywhere - and `readUInt32BE` throws ERR_OUT_OF_RANGE from inside a
 * socket 'message' handler, which would take the module process down.
 */
function readU32At(buffer: Buffer, pointer: number): number | undefined {
	if (pointer < 0 || pointer + 4 > buffer.length) {
		return undefined
	}
	return buffer.readUInt32BE(pointer)
}

/** As {@link readU32At}, but for the u16 pointers and tags `AV_EXTENDED` replies are built from. */
function readU16At(buffer: Buffer, pointer: number): number | undefined {
	if (pointer < 0 || pointer + 2 > buffer.length) {
		return undefined
	}
	return buffer.readUInt16BE(pointer)
}

/** Parses a tx-channel-friendly-names-query reply. */
function parseTxFriendlyNames(reply: Buffer): Partial<DeviceData> {
	const tx: AudioTxChannels = {}

	// const channelCount = reply[10]
	const recCount = reply[11]
	const startIndex = 12

	// set offsets
	const infoBufferSize = 6
	const nameNumberOffset = 2
	const friendlyNameIndexOffset = 4

	// for each channel
	// A reply carries at most CHANNELS_PER_PAGE records whatever the record-count byte claims, and a
	// truncated packet may hold fewer still - bound the loop by both rather than trusting the wire.
	for (let i = 0; i < Math.min(recCount, DANTE_CONST.CHANNELS_PER_PAGE.TX); i++) {
		// get info chunk of channel
		const infoIndex = startIndex + infoBufferSize * i
		const infoBuffer = reply.subarray(infoIndex, infoIndex + infoBufferSize)
		if (infoBuffer.length < infoBufferSize) {
			break
		}
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset)
		const nameIndex = bufferToInt(infoBuffer, friendlyNameIndexOffset)

		// create return object if needed
		if (tx[nameNumber] == undefined) {
			tx[nameNumber] = { number: nameNumber }
		}
		const returnChannel = tx[nameNumber]

		// get name
		returnChannel.friendlyName = parseStringAtPointer(reply, nameIndex)
	}
	return { audioTx: tx }
}

/**
 * Parses a tx-channel-query reply into channel names and sample rates.
 * Stops early (recording the count reached so far) if it encounters a channel from a different sample-rate group.
 */
function parseTxChannels(reply: Buffer): Partial<DeviceData> {
	const tx: AudioTxChannels = {}
	let firstChannelGroup: number | undefined

	// const channelCount = reply[10]
	const recCount = reply[11]
	const startIndex = 12

	// set offsets
	const infoBufferSize = 8
	const nameNumberOffset = 0
	const sampleRateOffset = 4
	const nameIndexOffset = 6

	// for each channel
	// A reply carries at most CHANNELS_PER_PAGE records whatever the record-count byte claims, and a
	// truncated packet may hold fewer still - bound the loop by both rather than trusting the wire.
	for (let i = 0; i < Math.min(recCount, DANTE_CONST.CHANNELS_PER_PAGE.TX); i++) {
		// get info chunk of channel
		const infoIndex = startIndex + infoBufferSize * i
		const infoBuffer = reply.subarray(infoIndex, infoIndex + infoBufferSize)
		if (infoBuffer.length < infoBufferSize) {
			tx.count = i
			break
		}
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset)
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset)

		// create return object if needed
		if (tx[nameNumber] == undefined) {
			tx[nameNumber] = { number: nameNumber }
		}
		const returnChannel = tx[nameNumber]

		// get name
		returnChannel.name = parseStringAtPointer(reply, nameIndex)

		// get sampleRate
		const sampleRateIndex = bufferToInt(infoBuffer, sampleRateOffset)
		if (i == 0) {
			firstChannelGroup = sampleRateIndex
		} else if (sampleRateIndex != firstChannelGroup) {
			tx.count = i
			break
		}
		returnChannel.sampleRate = readU32At(reply, sampleRateIndex)
	}
	return { audioTx: tx }
}

/**
 * Parses an rx-channel-query reply into channel names, sample rates, and subscription/routing info.
 * Stops early (recording the count reached so far) if it encounters a channel from a different sample-rate group.
 */
function parseRxChannels(reply: Buffer): Partial<DeviceData> {
	const rx: AudioRxChannels = {}
	let firstChannelGroup: number | undefined

	// const channelCount = reply[10]
	const recCount = reply[11]
	const startIndex = 12

	// set offsets
	const infoBufferSize = 20
	const nameNumberOffset = 0
	const sampleRateOffset = 4
	const nameIndexOffset = 10
	const sourceChannelOffset = 6
	const sourceDeviceOffset = 8
	const channelStatusOffset = 12
	const subscriptionStatusOffset = 14

	// for each channel
	// A reply carries at most CHANNELS_PER_PAGE records whatever the record-count byte claims, and a
	// truncated packet may hold fewer still - bound the loop by both rather than trusting the wire.
	for (let i = 0; i < Math.min(recCount, DANTE_CONST.CHANNELS_PER_PAGE.RX); i++) {
		// get info chunk of channel
		const infoIndex = startIndex + infoBufferSize * i
		const infoBuffer = reply.subarray(infoIndex, infoIndex + infoBufferSize)
		if (infoBuffer.length < infoBufferSize) {
			rx.count = i
			break
		}
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset)
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset)

		// create return object if needed
		if (rx[nameNumber] == undefined) {
			rx[nameNumber] = { number: nameNumber }
		}
		const returnChannel = rx[nameNumber]

		// get name
		returnChannel.name = parseStringAtPointer(reply, nameIndex)

		// get routing
		const sourceChannelIndex = bufferToInt(infoBuffer, sourceChannelOffset)
		const sourceDeviceIndex = bufferToInt(infoBuffer, sourceDeviceOffset)
		const sampleRateIndex = bufferToInt(infoBuffer, sampleRateOffset)
		if (i == 0) {
			firstChannelGroup = sampleRateIndex
		} else if (sampleRateIndex != firstChannelGroup) {
			rx.count = i
			break
		}
		returnChannel.sourceChannel = parseStringAtPointer(reply, sourceChannelIndex)
		returnChannel.sourceDevice = parseStringAtPointer(reply, sourceDeviceIndex)
		returnChannel.channelStatus = bufferToInt(infoBuffer, channelStatusOffset)
		returnChannel.subscriptionStatus = bufferToInt(infoBuffer, subscriptionStatusOffset)
		returnChannel.sampleRate = readU32At(reply, sampleRateIndex)
	}
	return { audioRx: rx }
}

/** Parses a device-name-query reply. */
function parseDeviceName(reply: Buffer): Partial<DeviceData> {
	return { name: parseString(reply, 10) }
}

/** Parses a device-settings-query reply into sample rate and latency. */
function parseDeviceSettings(reply: Buffer): Partial<DeviceData> {
	const deviceInfo: Partial<DeviceData> = {}
	const recCount = reply[11]
	const startIndex = 12
	const infoBufferSize = 4

	for (let i = 0; i < recCount; i++) {
		// get info chunk
		const infoIndex = startIndex + infoBufferSize * i
		const infoBuffer = reply.subarray(infoIndex, infoIndex + infoBufferSize)
		// The record count comes off the wire, so a truncated packet can promise more records than it
		// carries - stop at what is actually there rather than reading past the end.
		if (infoBuffer.length < infoBufferSize) break

		const infoCode = infoBuffer.readUInt16BE(0)
		// The value offset is device-supplied too, so dereference it defensively
		const value = readU32At(reply, infoBuffer.readUInt16BE(2))
		if (value === undefined) continue

		switch (infoCode) {
			case 0x8020:
				// Sample rate
				deviceInfo.sr = value
				break

			case 0x8301:
				// Latency
				deviceInfo.latency = value / 1000000
				break
		}
	}
	return deviceInfo
}

/**
 * Byte offsets within one channel-record descriptor of an `AV_EXTENDED` channel-directory reply
 * (`MESSAGE_TYPE_AV_RX_CHANNEL_QUERY`/`MESSAGE_TYPE_AV_TX_CHANNEL_QUERY`), relative to the
 * descriptor's own start - which the reply gives as one absolute-offset pointer per channel, not a
 * fixed stride, so records must be walked via those pointers rather than by a computed size.
 *
 * Reverse-engineered by diffing an identical multi-channel reply captured immediately after a
 * batch-clear and immediately after a batch-set: everything here was constant between the two
 * except the two source pointers, confirming their meaning. See the `dante-video-routing-protocol`
 * project notes for the full byte-by-byte derivation.
 */
const AV_CHANNEL_RECORD = {
	/** `AV_MEDIA_TYPE.AUDIO` or `.VIDEO` - the one dependable way to tell a record's kind. */
	MEDIA_TYPE: 6,
	/**
	 * The channel's number within its own media type, which is what a crosspoint command addresses
	 * it by - unlike the field at +2, which is its position across all the device's channels
	 * combined (a device's sole video channel, listed after two audio ones, reports +2 = 3 but
	 * +8 = 1).
	 */
	CHANNEL_NUMBER: 8,
	OWN_NAME_POINTER: 20,
	/** Absent (0) when the channel has no live source. */
	SOURCE_CHANNEL_NAME_POINTER: 48,
	/** Absent (0) when the channel has no live source. */
	SOURCE_DEVICE_NAME_POINTER: 50,
}

interface AvChannelRecord {
	channelNumber: number
	name?: string
	sourceChannel?: string
	sourceDevice?: string
}

/**
 * Walks every channel-record pointer an `AV_EXTENDED` channel-directory reply lists, decoding the
 * ones whose media type is `mediaType` (records of another kind are skipped, so a reply mixing
 * audio and video channels only yields the kind asked for).
 *
 * Matching is on the media type field, never on the opaque tag at each record's offset 0: that tag
 * varies by both reply kind and device model (see `AV_MEDIA_TYPE`), so a parser keyed to it works
 * only against the device it was derived from and silently reports zero channels everywhere else.
 *
 * The record count at offset 16 is a byte pair - a fixed `0x03` marker then the real count, the
 * same shape `MESSAGE_TYPE_AV_CROSSPOINT_CONTROL` uses - not a plain u16; reading it as one
 * inflates a 3-channel reply's count into the hundreds.
 */
function parseAvChannelDirectory(reply: Buffer, mediaType: number): AvChannelRecord[] {
	const recordCount = reply.length > 17 ? reply[17] : 0
	const records: AvChannelRecord[] = []

	for (let i = 0; i < recordCount; i++) {
		const descriptorStart = readU16At(reply, 18 + i * 2)
		if (descriptorStart === undefined) continue
		if (readU16At(reply, descriptorStart + AV_CHANNEL_RECORD.MEDIA_TYPE) !== mediaType) continue

		records.push({
			// Falls back to the running count for a record that somehow reports no number, so a
			// malformed reply still yields usable 1..n numbering rather than a channel 0.
			channelNumber: readU16At(reply, descriptorStart + AV_CHANNEL_RECORD.CHANNEL_NUMBER) || records.length + 1,
			name: parseStringAtPointer(reply, readU16At(reply, descriptorStart + AV_CHANNEL_RECORD.OWN_NAME_POINTER) ?? 0),
			sourceChannel: parseStringAtPointer(
				reply,
				readU16At(reply, descriptorStart + AV_CHANNEL_RECORD.SOURCE_CHANNEL_NAME_POINTER) ?? 0,
			),
			sourceDevice: parseStringAtPointer(
				reply,
				readU16At(reply, descriptorStart + AV_CHANNEL_RECORD.SOURCE_DEVICE_NAME_POINTER) ?? 0,
			),
		})
	}

	return records
}

/** Parses an `AV_EXTENDED` rx-side channel-directory reply into this device's video rx channels. */
function parseVideoRxChannels(reply: Buffer): Partial<DeviceData> {
	const videoRx: VideoRxChannels = {}
	let count = 0
	for (const record of parseAvChannelDirectory(reply, DANTE_CONST.AV_MEDIA_TYPE.VIDEO)) {
		videoRx[record.channelNumber] = {
			number: record.channelNumber,
			name: record.name,
			sourceChannel: record.sourceChannel,
			sourceDevice: record.sourceDevice,
		}
		// The highest number seen, not the number of records: channel numbers come from the device
		// now, so a gap in them would otherwise leave `count` short and hide the tail of the list
		// from every consumer that walks 1..count (the dropdown builders all do).
		count = Math.max(count, record.channelNumber)
	}
	videoRx.count = count
	return { videoRx }
}

/** Parses an `AV_EXTENDED` tx-side channel-directory reply into this device's video tx channels. */
function parseVideoTxChannels(reply: Buffer): Partial<DeviceData> {
	const videoTx: VideoTxChannels = {}
	let count = 0
	for (const record of parseAvChannelDirectory(reply, DANTE_CONST.AV_MEDIA_TYPE.VIDEO)) {
		videoTx[record.channelNumber] = { number: record.channelNumber, name: record.name }
		count = Math.max(count, record.channelNumber)
	}
	videoTx.count = count
	return { videoTx }
}

//**
//** Module API
//**

/**
 * Handles an incoming ARC socket message: parses the reply and merges the resulting
 * device info into `devicesData`, registering the device first if it's new.
 */
/** How a subscription reads in a log line: `Device / Channel`, or `-` for an empty one. */
function subscriptionLabel(channel: AudioRxChannel | undefined): string {
	if (!channel?.sourceDevice && !channel?.sourceChannel) return '-'
	return `${channel.sourceDevice ?? '?'} / ${channel.sourceChannel ?? '?'}`
}

/**
 * Reports routing changes on a device's receive channels at info.
 *
 * Called before the incoming page is merged, so `self.devicesData` still holds the previous state to
 * compare against. Only channels that were already known can have *changed* - a channel seen for the
 * first time is the initial state, not a route change, and logging those at info would print the
 * whole patch of every device on every connect. Those go to debug instead.
 *
 * The subscription status is included because a route can stop working without its source changing:
 * the transmitter going offline flips the status while the names stay put.
 */
function logRouteChanges(self: DanteInstance, deviceIp: string, incoming: AudioRxChannels | undefined): void {
	if (!incoming) return

	const deviceName = self.devicesData[deviceIp]?.name ?? deviceIp
	const known = self.devicesData[deviceIp]?.audioRx

	for (const key of Object.keys(incoming)) {
		// `count` shares the object with the numbered channels, so index by number to skip it
		const channelNumber = Number(key)
		if (!Number.isInteger(channelNumber)) continue

		const channel = incoming[channelNumber]
		const before = known?.[channelNumber]
		const channelName = channel.name ?? `channel ${channelNumber}`

		if (!before) {
			if (self.debug) {
				logger.debug(`${deviceName} ${channelName} <- ${subscriptionLabel(channel)}`)
			}
			continue
		}

		const wasConnected = isSubscriptionConnected(before.subscriptionStatus)
		const isConnected = isSubscriptionConnected(channel.subscriptionStatus)
		const sourceChanged = before.sourceDevice !== channel.sourceDevice || before.sourceChannel !== channel.sourceChannel

		if (sourceChanged) {
			logger.info(
				`Route changed: ${deviceName} ${channelName} <- ${subscriptionLabel(channel)}` +
					` (was ${subscriptionLabel(before)})${isConnected ? '' : ' - not connected'}`,
			)
		} else if (wasConnected !== isConnected) {
			// same subscription, different health - the source coming or going
			logger.info(
				`Route ${isConnected ? 'restored' : 'lost'}: ${deviceName} ${channelName} <- ${subscriptionLabel(channel)}`,
			)
		}
	}
}

export function parseReply(self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo): void {
	const deviceIp = rinfo.address
	const replySize = rinfo.size
	const deviceData: Record<string, Partial<DeviceData>> = {}
	const updateFlags: string[] = []

	if (self.debug) {
		// Log replies when in debug mode
		logger.debug(`ARC : Rx (${reply.length}): ${reply.toString('hex')}`)
	}

	// The protocol marker, size and command id are read at fixed offsets 0, 2 and 6. A datagram too
	// short to hold them is not one of ours - but `bufferToInt` does an unguarded `readUInt16BE`, so
	// without this it throws instead of failing to match, and the throw is fatal: this runs straight
	// off a socket's 'message' event. An empty UDP datagram is legal and enough to do it.
	if (reply.length < 8) return

	if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.CONTROL && replySize === bufferToInt(reply, 2)) {
		// mDNS discovery (danteDiscovery -> registerDevice) is the source of truth for a device's
		// existence - ignore ARC traffic from a device we haven't registered yet, so an unsolicited
		// broadcast can't race ahead of discovery and silently stub in a devicesData entry via merge()
		// (which would skip registerDevice's insertDeviceChoice()/timeoutArray setup).
		if (!self.devicesData[deviceIp]) {
			return
		}
		// Answering us is proof the device is online, so this re-arms its offline timer. Without it,
		// only an mDNS SRV answer and a HEARTBEAT multicast packet did - so a device in the middle of
		// a conversation with this module could still be declared offline and destroyed because three
		// polls' worth of discovery replies went missing, or because it emits no heartbeats at all.
		// Destroying it drops its channel choices, which takes its per-device option fields out of
		// every action and feedback until it is rediscovered and re-queried.
		keepAlive(self, deviceIp)

		const commandId = bufferToInt(reply, 6)

		deviceData[deviceIp] = {}

		switch (commandId) {
			// deviceName
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_NAME_QUERY: {
				deviceData[deviceIp] = parseDeviceName(reply)
				const currDevice = deviceData[deviceIp]

				if (self.devicesData[deviceIp]?.name != currDevice.name && currDevice.name !== undefined) {
					updateDeviceChoice(self, deviceIp, currDevice.name)
					updateFlags.push('name')
				}

				break
			}

			// channelCount
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_CHANNEL_COUNTS_QUERY: {
				deviceData[deviceIp] = parseChannelCount(reply)
				const currDevice = deviceData[deviceIp]

				logger.info(
					`${deviceLabel(self, deviceIp)} : audio channels - rx ${currDevice.audioRx?.count ?? 0}, ` +
						`tx ${currDevice.audioTx?.count ?? 0}`,
				)

				// if channel count has changed, retrieve channel names
				if (
					(currDevice.audioRx?.count ?? 0) > 0 &&
					currDevice.audioRx?.count != self.devicesData[deviceIp]?.audioRx?.count
				) {
					updateFlags.push('rxCount')
				}
				if (
					(currDevice.audioTx?.count ?? 0) > 0 &&
					currDevice.audioTx?.count != self.devicesData[deviceIp]?.audioTx?.count
				) {
					updateFlags.push('txCount')
				}
				// This reply also carries the channel counts and the lock flag, which are device
				// properties in their own right - the rxCount/txCount flags above only fire on a change
				// and only trigger follow-up queries, so without this `locked` never reached a variable.
				updateFlags.push('counts')
				break
			}

			// txChannels
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY: {
				deviceData[deviceIp] = parseTxChannels(reply)
				updateFlags.push('tx')
				break
			}

			// txChannelFriendlyNames
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY: {
				deviceData[deviceIp] = parseTxFriendlyNames(reply)
				updateFlags.push('tx')
				break
			}

			// rxChannels
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY: {
				deviceData[deviceIp] = parseRxChannels(reply)
				// must run before the merge below, which is what makes the incoming state the current one
				logRouteChanges(self, deviceIp, deviceData[deviceIp].audioRx)
				updateFlags.push('rx')
				break
			}

			// device settings
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_QUERY: {
				deviceData[deviceIp] = parseDeviceSettings(reply)
				updateFlags.push('info')
				break
			}
		}

		self.devicesData = merge(self.devicesData, deviceData)
		// update Channels choices for actions, feedbacks & variables

		for (const flag of updateFlags) {
			switch (flag) {
				case 'name':
					scheduleUpdateData(self)
					break
				case 'info':
					scheduleCheckVariables(self, deviceIp, 'sr', 'latency')
					// sample rate and latency are device properties a feedback can be reading
					scheduleCheckFeedbacks(self, deviceIp)
					break
				case 'rx':
					scheduleCheckVariables(self, deviceIp, 'rx', 'rx_names')
					updateChannelChoices(self, deviceIp, 'rx')
					// routes into this device changed - only feedbacks reading it can have flipped
					scheduleCheckFeedbacks(self, deviceIp)
					break
				case 'tx':
					scheduleCheckVariables(self, deviceIp, 'tx', 'tx_names')
					updateChannelChoices(self, deviceIp, 'tx')
					// this device's transmit channel names changed - feedbacks using it as a source match on
					// those names, so they need re-checking too
					scheduleCheckFeedbacks(self, deviceIp)
					break
				case 'counts':
					scheduleCheckVariables(self, deviceIp, 'rx', 'tx', 'locked')
					scheduleCheckFeedbacks(self, deviceIp)
					break
				case 'rxCount':
					getRxChannels(self, deviceIp)
					break
				case 'txCount':
					getTxChannels(self, deviceIp)
					getTxChannelFriendlyNames(self, deviceIp)
					break
			}
		}
	}
}

/**
 * Handles an incoming ARC socket message under the `AV_EXTENDED` protocol - the second protocol
 * some devices (so far, AV-X-capable ones) speak on the same socket/port as `CONTROL`. Parses
 * video channel-directory replies into `devicesData`; anything else under this protocol (crosspoint
 * and rename acknowledgements) carries nothing worth storing.
 *
 * Registered alongside {@link parseReply} on the same socket, and independent of it: each checks
 * its own protocol tag and returns immediately if the message is not its kind, so one socket can
 * carry both protocols without either parser needing to know about the other.
 */
export function parseAvReply(self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo): void {
	const deviceIp = rinfo.address
	const replySize = rinfo.size

	// Short enough that a corrupt or truncated packet cannot make any of the reads below throw.
	if (reply.length < 8) return
	if (
		(bufferToInt(reply, 0) & DANTE_CONST.AV_EXTENDED_MASK) !==
		(DANTE_CONST.PROTOCOL.AV_EXTENDED & DANTE_CONST.AV_EXTENDED_MASK)
	)
		return
	if (replySize !== bufferToInt(reply, 2)) return

	if (self.debug) {
		logger.debug(`ARC (AV) : Rx (${reply.length}): ${reply.toString('hex')}`)
	}

	// As in parseReply: mDNS discovery is the source of truth for a device's existence, so traffic
	// from one not yet registered is ignored rather than allowed to stub in a devicesData entry.
	if (!self.devicesData[deviceIp]) return
	// see parseReply - a reply is proof of life, and re-arms the offline timer
	keepAlive(self, deviceIp)

	const commandId = bufferToInt(reply, 6)
	let deviceData: Partial<DeviceData> | undefined
	let channelDirection: 'rx' | 'tx' | undefined

	switch (commandId) {
		case DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY:
			deviceData = parseVideoRxChannels(reply)
			channelDirection = 'rx'
			break
		case DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY:
			deviceData = parseVideoTxChannels(reply)
			channelDirection = 'tx'
			break
	}

	if (!deviceData) return

	const countBefore =
		channelDirection === 'rx' ? self.devicesData[deviceIp]?.videoRx?.count : self.devicesData[deviceIp]?.videoTx?.count

	self.devicesData = merge(self.devicesData, { [deviceIp]: deviceData })

	logVideoChannelCounts(self, deviceIp, channelDirection, countBefore)

	if (channelDirection) updateVideoChannelChoices(self, deviceIp, channelDirection)

	if (channelDirection === 'rx') {
		scheduleCheckVariables(self, deviceIp, 'rx_video', 'rx_names_video')
	} else if (channelDirection === 'tx') {
		scheduleCheckVariables(self, deviceIp, 'tx_video', 'tx_names_video')
	}
	scheduleCheckFeedbacks(self, deviceIp)
}

/**
 * Reports a device's video channel counts on one line, the way the audio counts are reported.
 *
 * The two directions arrive in separate replies, so this waits for the one that completes the pair
 * rather than logging each on its own - a device is one device, and "video rx channels - 0" on a
 * line of its own tells nobody anything until the transmit side turns up too. Waiting costs
 * nothing: the module always asks for both directions together, and every device answers both -
 * one that has no video, or does not speak `AV_EXTENDED` at all, answers with a reply the parsers
 * read as zero channels.
 *
 * Which is why zero/zero stays at debug: every audio-only Dante device on the network reports it,
 * and it is not news about any of them. The rest is logged only when this reply actually changed a
 * count, so a Refresh over an unchanged network says nothing at all.
 */
function logVideoChannelCounts(
	self: DanteInstance,
	deviceIp: string,
	channelDirection: 'rx' | 'tx' | undefined,
	countBefore: number | undefined,
): void {
	const device = self.devicesData[deviceIp]
	const rx = device?.videoRx
	const tx = device?.videoTx
	// not yet the reply that completes the pair
	if (!channelDirection || !rx || !tx) return

	const countAfter = channelDirection === 'rx' ? rx.count : tx.count
	if (countAfter === countBefore) return

	const line = `${deviceLabel(self, deviceIp)} : video channels - rx ${rx.count ?? 0}, tx ${tx.count ?? 0}`
	if ((rx.count ?? 0) === 0 && (tx.count ?? 0) === 0) logger.debug(line)
	else logger.info(line)
}

/**
 * Handles an incoming HEARTBEAT socket message: confirms the network is alive and
 * keeps the sending device from being considered offline.
 */
export function parseHeartbeatReply(self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo): void {
	// see parseReply - the marker and size at offsets 0 and 2 cannot be read from a shorter packet
	if (reply.length < 4) return

	if (
		bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.HEARTBEAT &&
		rinfo.size === bufferToInt(reply, 2) &&
		parseString(reply, 16) == 'Audinate'
	) {
		// Nothing here reports the status. Receiving on the heartbeat socket is what proves that
		// service is alive, and `noteTraffic` has already recorded it - from the socket handler, before
		// this ran. Forcing Ok here as well used to declare the whole connection healthy on the
		// strength of one socket, which is why the status flapped: this said Ok, and the next
		// `checkConnections` saw a service still marked down and said Disconnected again.

		// device is online
		keepAlive(self, rinfo.address)
	}
}

/**
 * Completes the discovery line once make and model are known.
 *
 * `insertDeviceChoice` announces a device the moment mDNS finds it, but at that point only its name
 * and address exist - make and model arrive later, in a settings reply, and only if the module has a
 * usable hardware address to ask with. Logged once, on the transition from unknown to known, since
 * this reply is re-requested on every settings refresh.
 */
function logDeviceIdentity(self: DanteInstance, deviceIp: string, incoming: Partial<DeviceData>): void {
	const known = self.devicesData[deviceIp]
	if (known?.modelName || !incoming.modelName) return

	// manufacturer is the full name, manfShortName the abbreviated one; either identifies the make
	const make = incoming.manufacturer || incoming.manfShortName || 'unknown make'
	logger.info(`${known?.name ?? deviceIp} (${deviceIp}) is a ${make} ${incoming.modelName}`)
}

/**
 * Handles an incoming SETTINGS socket message: parses the reply and merges the resulting
 * device settings info into `devicesData`.
 */
export function parseSettingsReply(self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo): void {
	const deviceIp = rinfo.address
	const replySize = rinfo.size
	const deviceData: Record<string, Partial<DeviceData>> = {}
	const updateFlags: string[] = []

	if (self.debug) {
		// Log replies when in debug mode
		logger.debug(`SETTINGS : Rx (${reply.length}): ${reply.toString('hex')}`)
	}

	// see parseReply - the marker and size at offsets 0 and 2
	if (reply.length < 4) return

	if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.SETTINGS && replySize == bufferToInt(reply, 2)) {
		// see parseHeartbeatReply: liveness is recorded by `noteTraffic` on the socket, not here

		// mDNS discovery (danteDiscovery -> registerDevice) is the source of truth for a device's
		// existence - ignore SETTINGS traffic (often unsolicited multicast) from a device we haven't
		// registered yet, so it can't race ahead of discovery and silently stub in a devicesData
		// entry via merge() (which would skip registerDevice's insertDeviceChoice()/timeoutArray setup).
		if (!self.devicesData[deviceIp]) {
			return
		}
		// see parseReply - a reply is proof of life, and re-arms the offline timer
		keepAlive(self, deviceIp)

		const payload = reply.subarray(24)
		// the command id sits at payload offset 2, so a reply truncated inside the header carries none
		if (payload.length < 4) return
		const commandId = bufferToInt(payload, 2)

		deviceData[deviceIp] = {}
		const currDevice = deviceData[deviceIp]

		switch (commandId) {
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_ENCODING_STATUS: {
				// get encoding setting
				const enc = bufferToInt(payload, 12, 4)
				const encValue = codeLabel(DANTE_CONST.ENCODINGS, enc) ?? enc
				currDevice.encoding = encValue
				// mark flag to update variables
				if (self.devicesData[deviceIp]?.encoding != encValue) {
					updateFlags.push('encoding')
				}
				// get encoding options
				let optionsOffset = bufferToInt(payload, 8)
				const optionsNumber = bufferToInt(payload, 10)
				if (optionsNumber && optionsNumber > 0) {
					currDevice.encodingOptions = []
					for (let i = 0; i < optionsNumber; i++) {
						currDevice.encodingOptions.push(bufferToInt(payload, optionsOffset, 4).toString())
						optionsOffset += 4
					}
					// mark flag to update variables
					if (
						!updateFlags.includes('encodingOptions') &&
						!compareArrays(currDevice.encodingOptions, self.devicesData[deviceIp]?.encodingOptions)
					) {
						updateFlags.push('encodingOptions')
					}
				}
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_STATUS: {
				// get sample rate setting
				const sr = bufferToInt(payload, 12, 4)
				currDevice.sr = sr
				// mark flag to update variables
				if (self.devicesData[deviceIp]?.sr != sr) {
					updateFlags.push('sr')
				}
				// get sample rate options
				let optionsOffset = bufferToInt(payload, 8)
				const optionsNumber = bufferToInt(payload, 10)
				if (optionsNumber && optionsNumber > 0) {
					currDevice.srOptions = []
					for (let i = 0; i < optionsNumber; i++) {
						currDevice.srOptions.push(bufferToInt(payload, optionsOffset, 4).toString())
						optionsOffset += 4
					}
					// mark flag to update variables
					if (
						!updateFlags.includes('srOptions') &&
						!compareArrays(currDevice.srOptions, self.devicesData[deviceIp]?.srOptions)
					) {
						updateFlags.push('srOptions')
					}
				}
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_PULLUP_STATUS: {
				// get pullup setting
				const pullup = bufferToInt(payload, 12, 4)
				currDevice.pullup = codeLabel(DANTE_CONST.PULLUPS, pullup)
				currDevice.pullup_string = parseString(payload, 32)
				// mark flag to update variables
				if (self.devicesData[deviceIp]?.pullup != currDevice.pullup) {
					updateFlags.push('pullup')
				}
				// get pullup options
				let optionsOffset = bufferToInt(payload, 8)
				const optionsNumber = bufferToInt(payload, 10)
				if (optionsNumber && optionsNumber > 0) {
					currDevice.pullupOptions = []
					for (let i = 0; i < optionsNumber; i++) {
						currDevice.pullupOptions.push(bufferToInt(payload, optionsOffset, 4).toString())
						optionsOffset += 4
					}
					// mark flag to update variables
					if (
						!updateFlags.includes('pullupOptions') &&
						!compareArrays(currDevice.pullupOptions, self.devicesData[deviceIp]?.pullupOptions)
					) {
						updateFlags.push('pullupOptions')
					}
				}
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_STATUS: {
				// currently only handles AVIO 2out
				const channelCount = 2
				currDevice.output_levels = []
				for (let i = 0; i < channelCount; i++) {
					const level = bufferToInt(payload, 24 + i * 4, 4)
					currDevice.output_levels.push(codeLabel(DANTE_CONST.LEVELS, level) ?? level)
					// mark flag to update variables
					if (
						!updateFlags.includes('output_levels') &&
						!compareArrays(currDevice.output_levels, self.devicesData[deviceIp]?.output_levels)
					) {
						updateFlags.push('output_levels')
					}
				}
				updateFlags.push('output_levels')
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_MANF_VERSIONS_STATUS: {
				currDevice.manfShortName = parseString(payload, 8)
				currDevice.manufacturer = parseString(payload, 52)
				currDevice.modelName = parseString(payload, 180)
				// before the merge, so "did we already know this" is still answerable
				logDeviceIdentity(self, deviceIp, currDevice)
				currDevice.softwareVersionMajor = bufferToInt(payload, 32, 1)
				currDevice.softwareVersionMinor = bufferToInt(payload, 33, 1)
				currDevice.softwareVersionPatch = bufferToInt(payload, 34, 2)
				currDevice.softwareVersionBuild = bufferToInt(payload, 44, 4)
				currDevice.productVersionMajor = bufferToInt(payload, 308, 1)
				currDevice.productVersionMinor = bufferToInt(payload, 309, 1)
				currDevice.productVersionPatch = bufferToInt(payload, 310, 2)
				currDevice.productVersionString = parseString(payload, 312)
				updateFlags.push('manf')
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_VERSIONS_STATUS: {
				currDevice.danteSoftwareVersionMajor = bufferToInt(payload, 8, 1)
				currDevice.danteSoftwareVersionMinor = bufferToInt(payload, 9, 1)
				currDevice.danteSoftwareVersionPatch = bufferToInt(payload, 10, 2)
				currDevice.danteSoftwareVersionBuild = bufferToInt(payload, 40, 4)
				currDevice.hardwareVersionMajor = bufferToInt(payload, 12, 1)
				currDevice.hardwareVersionMinor = bufferToInt(payload, 13, 1)
				currDevice.hardwareVersionPatch = bufferToInt(payload, 14, 2)
				currDevice.hardwareVersionBuild = bufferToInt(payload, 6, 1)
				currDevice.danteModel = parseString(payload, 64)
				updateFlags.push('versions')
				break
			}

			// These change notifications are how the module learns about anything it did not do
			// itself - a route or rename made in Dante Controller, or from another Companion. They
			// arrive on the SETTINGS multicast group and carry no state of their own, so each one is
			// answered by re-reading the affected directory.
			//
			// Video rides the same notifications: a video crosspoint or rename on an AV-X device
			// raises exactly these two message types, confirmed live against an encoder/decoder pair
			// (and confirmed silent when nothing changes, so this costs nothing at idle). The video
			// directories live under a different protocol, hence the extra queries rather than the
			// audio ones covering both.
			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CHANGE: {
				getRxChannels(self, deviceIp)
				getVideoRxChannels(self, deviceIp)
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_CHANGE: {
				getTxChannels(self, deviceIp)
				getTxChannelFriendlyNames(self, deviceIp)
				getVideoTxChannels(self, deviceIp)
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_LABEL_CHANGE: {
				getTxChannelFriendlyNames(self, deviceIp)
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_PROPERTY_CHANGE: {
				getSettings(self, deviceIp)
				break
			}
		}

		self.devicesData = merge(self.devicesData, deviceData)

		scheduleCheckVariables(self, deviceIp)
		// settings replies carry sample rate, pullup, encoding, output levels and model information -
		// all of them device properties a feedback can be reading
		scheduleCheckFeedbacks(self, deviceIp)

		// A settings reply carrying new option lists changes what the per-device sample rate, pullup and
		// encoding dropdowns offer, so the definitions have to be rebuilt. Schedule it rather than
		// rebuilding here: discovery brings a burst of these replies, one per setting per device, and
		// rebuilding on each one re-serialises every definition to the host each time.
		for (const flag of updateFlags) {
			if (flag.slice(-7) == 'Options') {
				scheduleUpdateData(self)
				break
			}
		}
	}
}

/**
 * Handles an incoming CMC socket message: parses per-service port announcements
 * and merges them into `devicesData`.
 */
export function parseCmcReply(self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo): void {
	const deviceIp = rinfo.address
	const replySize = rinfo.size
	const deviceData: Record<string, Partial<DeviceData>> = {}

	if (self.debug) {
		// Log replies when in debug mode
		logger.debug(`CMC : Rx Info(${reply.length}): ${reply.toString('hex')}`)
	}

	// see parseReply - marker, size and command id sit at offsets 0, 2 and 6
	if (reply.length < 8) return

	if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.CMC && replySize == bufferToInt(reply, 2)) {
		// mDNS discovery (danteDiscovery -> registerDevice) is the source of truth for a device's
		// existence - ignore CMC traffic from a device we haven't registered yet, so it can't race
		// ahead of discovery and silently stub in a devicesData entry via merge() (which would skip
		// registerDevice's insertDeviceChoice()/timeoutArray setup).
		if (!self.devicesData[deviceIp]) {
			return
		}
		// see parseReply - a reply is proof of life, and re-arms the offline timer
		keepAlive(self, deviceIp)

		const commandId = bufferToInt(reply, 6)
		deviceData[deviceIp] = {}
		const currDevice = deviceData[deviceIp]

		switch (commandId) {
			case 0x1001: {
				currDevice.ports = { SETTINGS: bufferToInt(reply, 28) }

				if (self.debug) {
					// plumbing, like the mDNS port announcements in discovery.ts
					const deviceId = self.devicesData[deviceIp]?.name ?? deviceIp
					logger.debug(`Port for service SETTINGS of device ${deviceId} is : ${bufferToInt(reply, 28)}`)
				}

				self.devicesData = merge(self.devicesData, deviceData)
				scheduleCheckVariables(self, deviceIp)
				scheduleCheckFeedbacks(self, deviceIp)
				refreshSettings(self, deviceIp)
				break
			}
		}
		// There was an unconditional all-devices/all-types sweep here. CMC replies only ever carry
		// service ports, and the only branch that mutates devicesData is 0x1001 above - which now
		// schedules its own scoped update (and that still refreshes the `devices` list variable).
	}
}

/** Builds an ARC-protocol Dante command message and advances the message counter. */
export function makeCommand(
	self: DanteInstance,
	commandType: number,
	commandArguments: Buffer = Buffer.alloc(2),
): Buffer {
	const requestFlag = Buffer.from([0x00, 0x00])
	const commandLength = intToBuffer(commandArguments.length + 11)

	const payload = Buffer.concat([
		intToBuffer(DANTE_CONST.PROTOCOL.CONTROL),
		commandLength,
		self.counter,
		intToBuffer(commandType),
		requestFlag,
		commandArguments,
		Buffer.from([0x00]),
	])

	incrementBE(self.counter)

	return payload
}

/** Builds a SETTINGS-protocol Dante command message and advances the message counter. */
export function makeSettingCommand(
	self: DanteInstance,
	commandType: number,
	commandArguments: Buffer = Buffer.alloc(2),
	/** The device this command is addressed to, so the right local card's address is embedded. */
	ipaddress?: string,
): Buffer {
	const commandLength = intToBuffer(commandArguments.length + 28)
	const startBlock = Buffer.from('2a84', 'hex')

	const payload = Buffer.concat([
		intToBuffer(DANTE_CONST.PROTOCOL.SETTINGS),
		commandLength,
		self.counter,
		startBlock,
		ipaddress === undefined ? self.mac : macForDevice(self, ipaddress),
		Buffer.from('0000', 'hex'),
		DANTE_CONST.AUDINATE_BUFFER,
		intToBuffer(commandType),
		commandArguments,
	])

	incrementBE(self.counter)

	return payload
}

/**
 * Builds an `AV_EXTENDED`-protocol Dante command message and advances the message counter.
 *
 * Simpler framing than {@link makeCommand}: no separate request-flag byte or trailing NUL, matching
 * what real `AV_EXTENDED` traffic was captured sending - `[proto][len][counter][commandType][0000][args]`.
 */
export function makeAvCommand(
	self: DanteInstance,
	commandType: number,
	commandArguments: Buffer = Buffer.alloc(0),
): Buffer {
	const commandLength = intToBuffer(commandArguments.length + 10)

	const payload = Buffer.concat([
		intToBuffer(DANTE_CONST.PROTOCOL.AV_EXTENDED),
		commandLength,
		self.counter,
		intToBuffer(commandType),
		intToBuffer(0),
		commandArguments,
	])

	incrementBE(self.counter)

	return payload
}

//**
//** Specific Dante messages
//**
