/**
 * Reading and writing Dante wire format: byte helpers, command framing, and reply parsers.
 */

import { DANTE_CONST } from './const.js'
import { codeLabel } from './protocol-rules.js'
import merge from '../utils/merge.js'
import { InstanceStatus, createModuleLogger } from '@companion-module/base'
import { UpdateActions } from '../actions.js'
import type dgram from 'node:dgram'
import type DanteInstance from '../main.js'
import type { DeviceData, RxChannels, TxChannels } from './types.js'
import { updateChannelChoices, updateDeviceChoice } from './choices.js'
import {
	keepAlive,
	macForDevice,
	scheduleCheckFeedbacks,
	scheduleCheckVariables,
	scheduleUpdateData,
} from './devices.js'
import { getRxChannels, getSettings, getTxChannelFriendlyNames, getTxChannels, refreshSettings } from './queries.js'

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
	return { tx: { count: reply[13] }, rx: { count: reply[15] }, locked }
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

/** Parses a tx-channel-friendly-names-query reply. */
function parseTxFriendlyNames(reply: Buffer): Partial<DeviceData> {
	const tx: TxChannels = {}

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
	return { tx }
}

/**
 * Parses a tx-channel-query reply into channel names and sample rates.
 * Stops early (recording the count reached so far) if it encounters a channel from a different sample-rate group.
 */
function parseTxChannels(reply: Buffer): Partial<DeviceData> {
	const tx: TxChannels = {}
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
	return { tx }
}

/**
 * Parses an rx-channel-query reply into channel names, sample rates, and subscription/routing info.
 * Stops early (recording the count reached so far) if it encounters a channel from a different sample-rate group.
 */
function parseRxChannels(reply: Buffer): Partial<DeviceData> {
	const rx: RxChannels = {}
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
	return { rx }
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

		const infoCode = infoBuffer.readUInt16BE(0)
		const valueIndex = infoBuffer.readUInt16BE(2)

		switch (infoCode) {
			case 0x8020:
				// Sample rate
				deviceInfo.sr = reply.readUInt32BE(valueIndex)
				break

			case 0x8301:
				// Latency
				deviceInfo.latency = reply.readUInt32BE(valueIndex) / 1000000
				break
		}
	}
	return deviceInfo
}

//**
//** Module API
//**

/**
 * Handles an incoming ARC socket message: parses the reply and merges the resulting
 * device info into `devicesData`, registering the device first if it's new.
 */
export function parseReply(self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo): void {
	const deviceIp = rinfo.address
	const replySize = rinfo.size
	const deviceData: Record<string, Partial<DeviceData>> = {}
	const updateFlags: string[] = []

	if (self.debug) {
		// Log replies when in debug mode
		logger.debug(`ARC : Rx (${reply.length}): ${reply.toString('hex')}`)
	}

	if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.CONTROL && replySize === bufferToInt(reply, 2)) {
		// mDNS discovery (danteDiscovery -> registerDevice) is the source of truth for a device's
		// existence - ignore ARC traffic from a device we haven't registered yet, so an unsolicited
		// broadcast can't race ahead of discovery and silently stub in a devicesData entry via merge()
		// (which would skip registerDevice's insertDeviceChoice()/timeoutArray setup).
		if (!self.devicesData[deviceIp]) {
			return
		}

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

				// if channel count has changed, retrieve channel names
				if ((currDevice.rx?.count ?? 0) > 0 && currDevice.rx?.count != self.devicesData[deviceIp]?.rx?.count) {
					updateFlags.push('rxCount')
				}
				if ((currDevice.tx?.count ?? 0) > 0 && currDevice.tx?.count != self.devicesData[deviceIp]?.tx?.count) {
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
 * Handles an incoming HEARTBEAT socket message: confirms the network is alive and
 * keeps the sending device from being considered offline.
 */
export function parseHeartbeatReply(self: DanteInstance, reply: Buffer, rinfo: dgram.RemoteInfo): void {
	if (
		bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.HEARTBEAT &&
		rinfo.size === bufferToInt(reply, 2) &&
		parseString(reply, 16) == 'Audinate'
	) {
		// network is alive
		if (!self.CONNECTED) {
			self.updateStatus(InstanceStatus.Ok)
			self.CONNECTED = true
		}

		// device is online
		keepAlive(self, rinfo.address)
	}
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

	if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.SETTINGS && replySize == bufferToInt(reply, 2)) {
		// network is alive
		if (!self.CONNECTED) {
			self.updateStatus(InstanceStatus.Ok)
			self.CONNECTED = true
		}

		// mDNS discovery (danteDiscovery -> registerDevice) is the source of truth for a device's
		// existence - ignore SETTINGS traffic (often unsolicited multicast) from a device we haven't
		// registered yet, so it can't race ahead of discovery and silently stub in a devicesData
		// entry via merge() (which would skip registerDevice's insertDeviceChoice()/timeoutArray setup).
		if (!self.devicesData[deviceIp]) {
			return
		}

		const payload = reply.subarray(24)
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
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CHANGE: {
				getRxChannels(self, deviceIp)
				break
			}

			case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_CHANGE: {
				getTxChannels(self, deviceIp)
				getTxChannelFriendlyNames(self, deviceIp)
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

		for (const flag of updateFlags) {
			if (flag.slice(-7) == 'Options') {
				UpdateActions(self)
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

	if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.CMC && replySize == bufferToInt(reply, 2)) {
		// mDNS discovery (danteDiscovery -> registerDevice) is the source of truth for a device's
		// existence - ignore CMC traffic from a device we haven't registered yet, so it can't race
		// ahead of discovery and silently stub in a devicesData entry via merge() (which would skip
		// registerDevice's insertDeviceChoice()/timeoutArray setup).
		if (!self.devicesData[deviceIp]) {
			return
		}

		const commandId = bufferToInt(reply, 6)
		deviceData[deviceIp] = {}
		const currDevice = deviceData[deviceIp]

		switch (commandId) {
			case 0x1001: {
				currDevice.ports = { SETTINGS: bufferToInt(reply, 28) }

				const deviceId = self.devicesData[deviceIp]?.name ?? deviceIp
				logger.info(`Port for service SETTINGS of device ${deviceId} is : ${bufferToInt(reply, 28)}`)

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

//**
//** Specific Dante messages
//**
