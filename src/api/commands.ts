/**
 * Commands that change something on a device.
 */

import { DANTE_CONST, validateDanteName } from '../const.js'
import { Regex, createModuleLogger } from '@companion-module/base'
import type DanteInstance from '../main.js'
import { intToBuffer, makeCommand, makeSettingCommand } from './protocol.js'
import { sendCommand } from './connection.js'
import { findDeviceIpByName, findRxChannelByName, findTxChannelByName, getChannelSubscriptionName } from './devices.js'

const logger = createModuleLogger('api')

/** Resets a device's name back to its factory default. */
export function resetDeviceName(self: DanteInstance, ipaddress: string): void {
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
			// see the note in setTxChannelName - 4 bytes, matching the 0x0024 pointer below
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
export function setRxChannelName(
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
export function setTxChannelName(
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
export function resetRxChannelName(self: DanteInstance, ipaddress: string, channelNumber = 0): void {
	setRxChannelName(self, ipaddress, channelNumber)
}

/** Clears the name of a tx channel on a device back to its default. */
export function resetTxChannelName(self: DanteInstance, ipaddress: string, channelNumber = 0): void {
	setTxChannelName(self, ipaddress, channelNumber)
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
export function clearAllCrosspoints(self: DanteInstance, destinationDevice: string): void {
	// Check if destinationDevice is an IP or a name
	const IP = RegExp(Regex.IP.slice(1, -1))
	const ipaddress = IP.test(destinationDevice) ? destinationDevice : findDeviceIpByName(self, destinationDevice)

	if (!ipaddress) {
		logger.error("Can't find " + destinationDevice + ' IP address')
		return
	}

	const rxCount = self.devicesData[ipaddress]?.rx?.count ?? 0
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

/** Subscribes a destination rx channel to a source tx channel, creating a Dante crosspoint. */
export function makeCrosspoint(
	self: DanteInstance,
	destinationDevice: string,
	sourceChannelName: string,
	sourceDeviceName: string,
	destinationChannel: string | number,
): void {
	const sourceChannel = findTxChannelByName(self, sourceDeviceName, sourceChannelName)
	const sourceSubscriptionName = getChannelSubscriptionName(sourceChannel) || sourceChannelName
	const sourceChannelNameBuffer = Buffer.from(sourceSubscriptionName, 'ascii')
	const sourceDeviceNameBuffer = Buffer.from(sourceDeviceName, 'ascii')

	const destinationChannelNumber =
		findRxChannelByName(self, destinationDevice, String(destinationChannel))?.number ?? destinationChannel

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

	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.subscription, commandArguments)

	sendCommand(self, commandBuffer, ipaddress)

	// get updated routing for feedback
	//		getRxChannels(self, ipaddress);
}

/** Unsubscribes a destination rx channel, clearing its Dante crosspoint. */
export function clearCrosspoint(
	self: DanteInstance,
	destinationDevice: string,
	destinationChannel: string | number,
): void {
	const destinationChannelNumber =
		findRxChannelByName(self, destinationDevice, String(destinationChannel))?.number ?? destinationChannel

	if (!hasChannel(Number(destinationChannelNumber), 'clear crosspoint')) return

	// Check if destinationDevice is an IP or a name
	const IP = RegExp(Regex.IP.slice(1, -1))
	const ipaddress = IP.test(destinationDevice) ? destinationDevice : findDeviceIpByName(self, destinationDevice)

	if (!ipaddress) {
		logger.error("Can't find " + destinationDevice + ' IP address')
		return
	}

	const commandArguments = Buffer.concat([
		Buffer.from('0401', 'hex'),
		intToBuffer(Number(destinationChannelNumber)),
		Buffer.from('005c006d', 'hex'),
		Buffer.alloc(1),
	])

	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.subscription, commandArguments)

	sendCommand(self, commandBuffer, ipaddress)
}

/** Sets a device's link-offset latency. */
export function setLatency(self: DanteInstance, ipaddress: string, latency: number): void {
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
