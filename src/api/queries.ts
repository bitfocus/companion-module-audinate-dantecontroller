/**
 * Commands that ask a device for information.
 */

import { createModuleLogger } from '@companion-module/base'
import { DANTE_CONST } from './const.js'
import type DanteInstance from '../main.js'
import { incrementBE, intToBuffer, makeAvCommand, makeCommand, makeSettingCommand } from './protocol.js'
import { sendCommand } from './connection.js'
import { setEncoding, setSampleRate } from './commands.js'
import { deviceLabel, macForDevice, markChannelsSettling } from './devices.js'

const logger = createModuleLogger('api:queries')

/**
 * Records an outgoing query, when verbose logging is on.
 *
 * Queries are the half of the conversation the packet dumps in `parseReply` do not show, and a
 * device that answers nothing looks identical to one that was never asked. Naming the query and its
 * target makes the difference visible.
 */
function logQuery(self: DanteInstance, deviceIp: string, what: string): void {
	if (!self.debug) return
	logger.debug(`Query -> ${deviceLabel(self, deviceIp)} : ${what}`)
}

/**
 * Queries a device's rx/tx channel counts.
 * @returns The device's last-known channel count entry, if any (the reply itself arrives asynchronously via {@link parseReply}).
 */
export function getChannelCount(self: DanteInstance, ipaddress: string): number | undefined {
	logQuery(self, ipaddress, 'channel counts')
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.channelCount)
	sendCommand(self, commandBuffer, ipaddress)

	return self.devicesData[ipaddress]?.channelCount
}

/** Queries a device's tx channel friendly names, paginating the request 32 channels at a time. */
export function getTxChannelFriendlyNames(self: DanteInstance, ipaddress: string): void {
	const device = self.devicesData[ipaddress]
	if (!device) {
		return
	}
	// clear registered friendly names
	for (let i = 1; i <= (device.audioTx?.count ?? 0); i++) {
		const channel = device.audioTx?.[i]
		if (channel) {
			delete channel.friendlyName
		}
	}
	sendChannelQuery(
		self,
		ipaddress,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY,
		device.audioTx?.count ?? 0,
		DANTE_CONST.CHANNELS_PER_PAGE.TX,
	)
}

/** Queries a device's tx channel details (names, sample rates), paginating the request 32 channels at a time. */
export function getTxChannels(self: DanteInstance, ipaddress: string): void {
	sendChannelQuery(
		self,
		ipaddress,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY,
		self.devicesData[ipaddress]?.audioTx?.count ?? 0,
		DANTE_CONST.CHANNELS_PER_PAGE.TX,
	)
}

/** Queries a device's rx channel details (names, routing, subscription status), paginating the request 16 channels at a time. */
/**
 * Sends a channel query, one command per page, covering `channelCount` channels.
 *
 * Always sends at least one page: before a device has reported its channel counts that first query
 * is how they get discovered.
 */
function sendChannelQuery(
	self: DanteInstance,
	ipaddress: string,
	commandType: number,
	channelCount: number,
	channelsPerPage: number,
): void {
	// the replies to these pages are the channel list filling in, not changing - see the rename logging
	markChannelsSettling(self, ipaddress)

	const pages = Math.max(1, Math.ceil(channelCount / channelsPerPage))
	if (self.debug) {
		logger.debug(
			`Query -> ${deviceLabel(self, ipaddress)} : channel details, ${pages} page(s) of ${channelsPerPage}` +
				` covering ${channelCount} channel(s)`,
		)
	}

	for (let page = 0; page < pages; page++) {
		const commandArguments = Buffer.from('0001000100', 'hex')
		// The starting channel is a big-endian u16 spanning argument bytes 2-3. Writing a single byte
		// at byte 3 produced identical packets for channels 1-255 but threw ERR_OUT_OF_RANGE beyond
		// that, so a device with more than 255 channels in one direction could not be paged past the
		// first 255. Writing the full u16 is the same bytes below 256 and correct above it.
		commandArguments.writeUInt16BE(page * channelsPerPage + 1, 2)
		sendCommand(self, makeCommand(self, commandType, commandArguments), ipaddress)
	}
}

/**
 * How many times a device is re-asked for a video directory it has never answered.
 *
 * Bounded rather than endless: most devices on a Dante network are not AV-X, and a budget stops
 * this becoming a standing query for every one of them.
 */
const VIDEO_DIRECTORY_ATTEMPTS = 5

/** Attempts spent per `<ip>:<direction>`, weakly held so a discarded instance is still collectable. */
const videoDirectoryAttempts = new WeakMap<DanteInstance, Map<string, number>>()

/**
 * Re-asks for video directories that never arrived, once per discovery sweep.
 *
 * `getVideoRxChannels`/`getVideoTxChannels` are one-shot: sent when a device's ARC port is first
 * learned, when a channel-change notification arrives, after one of this module's own writes, and on
 * the Refresh action. Nothing retried them, so a single dropped reply left the directory permanently
 * unknown - and the crosspoint feedbacks read the transmit directory to match a destination's
 * reported source against a selected channel, so they silently read false until somebody pressed
 * Refresh. The receive side self-heals on the next route change; the transmit side is re-read only
 * on a *rename*, which may never happen.
 *
 * Only devices that answered nothing at all are re-asked. A device that replied has the field set
 * even when it reported no video channels - including one that does not speak `AV_EXTENDED`, whose
 * unrecognised-command reply parses as zero channels - so this cannot spin on a device that has
 * genuinely told us it has none.
 */
export function retryMissingVideoDirectories(self: DanteInstance): void {
	let attempts = videoDirectoryAttempts.get(self)
	if (!attempts) {
		attempts = new Map()
		videoDirectoryAttempts.set(self, attempts)
	}

	// release the budget of anything no longer on the network, so a device that returns starts over
	for (const key of [...attempts.keys()]) {
		if (!self.devicesData[key.slice(0, key.lastIndexOf(':'))]) attempts.delete(key)
	}

	for (const [ipaddress, device] of Object.entries(self.devicesData)) {
		// nothing to ask over until discovery has learned where to send it
		if (!device?.ports?.ARC) continue

		for (const direction of ['rx', 'tx'] as const) {
			if ((direction === 'rx' ? device.videoRx : device.videoTx) !== undefined) continue

			const key = `${ipaddress}:${direction}`
			const spent = attempts.get(key) ?? 0
			if (spent >= VIDEO_DIRECTORY_ATTEMPTS) continue
			attempts.set(key, spent + 1)

			if (self.debug) {
				logger.debug(`Re-asking ${deviceLabel(self, ipaddress)} for its video ${direction} directory`)
			}

			if (direction === 'rx') getVideoRxChannels(self, ipaddress)
			else getVideoTxChannels(self, ipaddress)
		}
	}
}

/**
 * Queries a device's video rx channels (names and live subscription source) under the
 * `AV_EXTENDED` protocol, using the fixed {@link DANTE_CONST.AV_CHANNEL_DIRECTORY_QUERY_ARGS}
 * argument bytes this opcode requires - an empty-argument query is acknowledged but always reports
 * zero records, even from a device with real channels. Safe to send to any device regardless of
 * whether it actually has video channels - one that does not, or does not speak `AV_EXTENDED` at
 * all, answers with an unrecognized-command reply that {@link parseVideoRxChannels} in
 * `protocol.ts` reads as zero channels rather than an error.
 */
export function getVideoRxChannels(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'video rx channels')
	markChannelsSettling(self, ipaddress)
	sendCommand(
		self,
		makeAvCommand(
			self,
			DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY,
			DANTE_CONST.AV_CHANNEL_DIRECTORY_QUERY_ARGS,
		),
		ipaddress,
	)
}

/** Queries a device's video tx channels (names). See {@link getVideoRxChannels}. */
export function getVideoTxChannels(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'video tx channels')
	markChannelsSettling(self, ipaddress)
	sendCommand(
		self,
		makeAvCommand(
			self,
			DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY,
			DANTE_CONST.AV_CHANNEL_DIRECTORY_QUERY_ARGS,
		),
		ipaddress,
	)
}

export function getRxChannels(self: DanteInstance, ipaddress: string): void {
	// audioRx.count, not audioTx.count - paging the receive query by the transmit count silently truncates
	// discovery on any device with more inputs than outputs (a 32x8 DSP would only ever report its
	// first 16 receive channels)
	sendChannelQuery(
		self,
		ipaddress,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY,
		self.devicesData[ipaddress]?.audioRx?.count ?? 0,
		DANTE_CONST.CHANNELS_PER_PAGE.RX,
	)
}

/** Queries a device's name. */
export function getDeviceName(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'device name')
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_NAME_QUERY)
	sendCommand(self, commandBuffer, ipaddress)
}

/** Queries a device's settings (sample rate, latency). */
export function getSettings(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'device settings')
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_QUERY)
	sendCommand(self, commandBuffer, ipaddress)
}

/** Queries a device's current sample rate. */
export function getSampleRate(self: DanteInstance, ipaddress: string): void {
	setSampleRate(self, ipaddress, 0)
}

/** Queries a device's current sample rate pullup setting. */
export function getPullup(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'sample rate pullup')
	const flag = intToBuffer(0, 4)
	const commandArguments = Buffer.concat([Buffer.from('00000064', 'hex'), flag, intToBuffer(0, 4)])
	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_PULLUP_CONTROL,
		commandArguments,
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Queries a device's current audio encoding. */
export function getEncoding(self: DanteInstance, ipaddress: string): void {
	setEncoding(self, ipaddress, 0)
}

/** Queries a device's current output levels. */
export function getLevel(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'output levels')
	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_CONTROL,
		intToBuffer(0, 4),
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Queries a device's manufacturer/model version info. */
export function getManfVersion(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'manufacturer and model')
	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_MANF_VERSIONS_QUERY,
		intToBuffer(0, 4),
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Queries a device's Dante firmware/product version info. */
export function getVersion(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'firmware and product versions')
	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_VERSIONS_QUERY,
		intToBuffer(0, 4),
		ipaddress,
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Queries a device's SETTINGS service port over the CMC socket. */
export function getSettingsPort(self: DanteInstance, ipaddress: string): void {
	logQuery(self, ipaddress, 'SETTINGS service port')
	const commandBuffer = Buffer.concat([
		intToBuffer(0x1200, 2),
		intToBuffer(20), // command size
		self.counter,
		intToBuffer(0x1001),
		intToBuffer(0),
		intToBuffer(0x3520),
		macForDevice(self, ipaddress),
		intToBuffer(0x0000),
	])

	sendCommand(self, commandBuffer, ipaddress, 'CMC')

	incrementBE(self.counter)
}

/**
 * Re-queries SETTINGS-service parameters (sample rate, pullup, encoding, level, versions) for
 * one device, or all known devices if none is given.
 */
export function refreshSettings(self: DanteInstance, deviceIp?: string): void {
	const ipArray = deviceIp ? [deviceIp] : Object.keys(self.devicesData)
	if (self.debug) {
		logger.debug(`Refreshing SETTINGS parameters for ${ipArray.length} device(s)`)
	}
	for (const ip of ipArray) {
		getSampleRate(self, ip)
		getPullup(self, ip)
		getEncoding(self, ip)
		getLevel(self, ip)
		getVersion(self, ip)
		getManfVersion(self, ip)
	}
}

/**
 * Re-queries ARC-service parameters (device name, settings, rx/tx channels) for one device,
 * or all known devices if none is given.
 */
export function refreshArc(self: DanteInstance, deviceIp?: string): void {
	const ipArray = deviceIp ? [deviceIp] : Object.keys(self.devicesData)
	if (self.debug) {
		logger.debug(`Refreshing ARC parameters for ${ipArray.length} device(s)`)
	}
	for (const ip of ipArray) {
		getDeviceName(self, ip)
		getSettings(self, ip)
		getRxChannels(self, ip)
		getTxChannels(self, ip)
		getTxChannelFriendlyNames(self, ip)
		getVideoRxChannels(self, ip)
		getVideoTxChannels(self, ip)
	}
}
