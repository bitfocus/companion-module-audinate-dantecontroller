import multidns from 'multicast-dns'
import { debounce, throttle, type DebouncedFunc } from 'es-toolkit/compat'
import dgram from 'node:dgram'
import merge from './utils/merge.js'
import { InstanceStatus, Regex, createModuleLogger, type DropdownChoice } from '@companion-module/base'
import { DANTE_CONST, validateDanteName } from './const.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdateVariableDefinitions, CheckVariables } from './variables.js'
import {
	listNetworkInterfaces,
	resolveConfiguredInterface,
	findInterfaceForAddress,
	encodeInterfaceId,
} from './config.js'
import type DanteInstance from './main.js'

const logger = createModuleLogger('api')

//**
//** Types
//**

export type ServiceName = 'ARC' | 'SETTINGS' | 'CMC' | 'HEARTBEAT'

/**
 * Everything whose liveness feeds into the overall instance status: the four UDP sockets
 * plus mDNS discovery, which has no socket of its own in `DanteSockets`.
 */
export type ConnectionName = ServiceName | 'MDNS'

export type DanteSockets = Partial<Record<ServiceName, dgram.Socket>>

export interface TxChannel {
	number: number
	name?: string
	friendlyName?: string
	sampleRate?: number
}

export interface RxChannel {
	number: number
	name?: string
	sourceChannel?: string
	sourceDevice?: string
	channelStatus?: number
	subscriptionStatus?: number
	sampleRate?: number
}

export type TxChannels = Record<number, TxChannel> & { count?: number }
export type RxChannels = Record<number, RxChannel> & { count?: number }

// A minimal local view of the mDNS answer/response shapes this module actually reads.
// `multidns.ResponsePacket`'s `answers`/`additionals` fields don't resolve reliably through
// this project's module setup (a quirk of the `export =` + namespace merge in its upstream
// types), so this is defined locally rather than relying on that import.
export interface MdnsPtrAnswer {
	type: 'PTR'
	name: string
	data: string
}

export interface MdnsSrvAnswer {
	type: 'SRV'
	name: string
	data: { port: number }
}

export type MdnsAnswer = MdnsPtrAnswer | MdnsSrvAnswer

export interface MdnsResponsePacket {
	answers: MdnsAnswer[]
	additionals: MdnsAnswer[]
}

export interface DeviceData {
	name?: string
	/** True when the device is locked and will refuse configuration changes. */
	locked?: boolean
	/**
	 * Hex MAC of the local card that reaches this device, when the card is chosen automatically.
	 * Undefined when a card was configured explicitly, in which case that one is used throughout.
	 */
	interfaceMac?: string
	ports?: Partial<Record<ServiceName, number>>
	tx?: TxChannels
	rx?: RxChannels
	channelCount?: number
	sr?: number
	srOptions?: string[]
	latency?: number
	pullup?: string
	pullup_string?: string
	pullupOptions?: string[]
	encoding?: string | number
	encodingOptions?: string[]
	output_levels?: (string | number)[]
	manfShortName?: string
	manufacturer?: string
	modelName?: string
	softwareVersionMajor?: number
	softwareVersionMinor?: number
	softwareVersionPatch?: number
	softwareVersionBuild?: number
	productVersionMajor?: number
	productVersionMinor?: number
	productVersionPatch?: number
	productVersionString?: string
	danteSoftwareVersionMajor?: number
	danteSoftwareVersionMinor?: number
	danteSoftwareVersionPatch?: number
	danteSoftwareVersionBuild?: number
	hardwareVersionMajor?: number
	hardwareVersionMinor?: number
	hardwareVersionPatch?: number
	hardwareVersionBuild?: number
	danteModel?: string
	timeoutArray?: [NodeJS.Timeout]
}

export type DevicesData = Record<string, DeviceData>

function compareArrays(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

// dgram's reusePort option wraps SO_REUSEPORT, which Node/libuv only supports on Linux -
// requesting it on macOS/BSD throws ENOTSUP regardless of bind address (confirmed: it fails
// the same way whether bound to a specific interface or the wildcard address), so only
// request it on Linux.
const REUSE_PORT_OPTION: { reusePort?: true } = process.platform === 'linux' ? { reusePort: true } : {}

//**
//** utils functions to parse dante messages
//**

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

/** @returns The channel's friendly name if set, otherwise its plain name. */
export function getChannelSubscriptionName(
	channel: { friendlyName?: string; name?: string } | undefined,
): string | undefined {
	return channel?.friendlyName || channel?.name
}

/** @returns True if the device has at least one rx (destination) channel. */
export function hasRxChannels(device: DeviceData | undefined): boolean {
	return (device?.rx?.count ?? 0) > 0
}

/** @returns True if the device has at least one tx (source) channel. */
export function hasTxChannels(device: DeviceData | undefined): boolean {
	return (device?.tx?.count ?? 0) > 0
}

/** @returns The IP address of the device with this name, if known. */
export function findDeviceIpByName(self: DanteInstance, deviceName: string): string | undefined {
	for (const [ip, device] of Object.entries(self.devicesData)) {
		if (device?.name == deviceName) {
			return ip
		}
	}
	return undefined
}

/** Finds a tx channel by name (or friendly name) on a device, identified by IP or device name. */
export function findTxChannelByName(
	self: DanteInstance,
	deviceIdentifier: string,
	channelName: string,
): TxChannel | undefined {
	let device: DeviceData | undefined = self.devicesData[deviceIdentifier]
	if (!device) {
		const deviceIp = findDeviceIpByName(self, deviceIdentifier)
		device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	}
	if (!device?.tx) {
		return undefined
	}
	// `tx`/`rx` also carry a non-numeric `count` property alongside the numeric channel keys,
	// so Object.entries()'s value type includes it too - the isNaN check filters it out at runtime.
	for (const [channelNumber, channel] of Object.entries(device.tx)) {
		if (isNaN(Number(channelNumber))) continue
		const txChannel = channel as TxChannel
		if (txChannel?.name == channelName || txChannel?.friendlyName == channelName) {
			return txChannel
		}
	}
	return undefined
}

/** Finds an rx channel by name on a device, identified by IP or device name. */
export function findRxChannelByName(
	self: DanteInstance,
	deviceIdentifier: string,
	channelName: string,
): RxChannel | undefined {
	let device: DeviceData | undefined = self.devicesData[deviceIdentifier]
	if (!device) {
		const deviceIp = findDeviceIpByName(self, deviceIdentifier)
		device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	}
	if (!device?.rx) {
		return undefined
	}
	for (const [channelNumber, channel] of Object.entries(device.rx)) {
		if (isNaN(Number(channelNumber))) continue
		const rxChannel = channel as RxChannel
		if (rxChannel?.name == channelName) {
			return rxChannel
		}
	}
	return undefined
}

/**
 * Joins a multicast group, scoped to `interfaceIp` when one is available.
 *
 * `dgram.addMembership` throws synchronously (EADDRNOTAVAIL, ENODEV, ENOBUFS...) rather than
 * emitting - and it is called from a 'listening' handler, so an uncaught throw here would take
 * down the module process. The interface can disappear between the availability check in
 * `initConnection` and the socket actually binding, which makes this reachable in practice.
 *
 * @returns True if the socket joined the group and can receive its traffic.
 */
function joinMulticastGroup(
	socket: dgram.Socket,
	group: string,
	service: ServiceName,
	interfaceIps: string[],
): boolean {
	// Joining without naming an interface leaves the choice to the routing table, which picks the
	// default route - not necessarily the card the Dante devices are on. When the card is chosen
	// automatically we therefore join on every interface explicitly rather than letting one be
	// chosen for us.
	let joined = 0
	for (const interfaceIp of interfaceIps) {
		try {
			socket.addMembership(group, interfaceIp)
			joined++
		} catch (error) {
			// Not every interface can carry multicast, and with several of them one failing is
			// expected rather than fatal - only report if none of them worked.
			logger.debug(
				`${service} socket : could not join ${group} on ${interfaceIp} : ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	if (joined === 0) {
		logger.error(`${service} socket : failed to join multicast group ${group} on any interface`)
	}
	return joined > 0
}

/**
 * Re-evaluates overall connection status from the ARC/CMC/SETTINGS/HEARTBEAT socket states
 * and mDNS discovery, and updates the instance status accordingly.
 * @returns True if all connections are active.
 */
export function checkConnections(self: DanteInstance): boolean {
	const services: ConnectionName[] = ['ARC', 'CMC', 'SETTINGS', 'HEARTBEAT', 'MDNS']
	for (const service of services) {
		if (!self.activeConnections[service]) {
			if (self.CONNECTED) {
				self.CONNECTED = false
				self.updateStatus(InstanceStatus.Disconnected)
			}
			return false
		}
	}
	if (!self.CONNECTED) {
		self.CONNECTED = true
		// Sockets are up, so discovery and routing work - but without a usable interface the
		// settings socket gets no replies, so report the misconfiguration rather than a plain Ok.
		if (self.configError) {
			self.updateStatus(InstanceStatus.BadConfig, self.configError)
		} else {
			self.updateStatus(InstanceStatus.Ok)
		}
	}
	return true
}

/**
 * Cancels every device's pending offline timeout.
 *
 * Must be called before `devicesData` is reset or the instance is torn down: the timers hold a
 * closure over `self` and the device IP, so an orphaned one fires up to `timeoutInterval` later
 * and calls `destroyDevice` for an IP that fresh discovery has since re-registered - silently
 * removing a device that is present and responding.
 */
export function clearDeviceTimeouts(self: DanteInstance): void {
	for (const device of Object.values(self.devicesData)) {
		clearTimeout(device?.timeoutArray?.[0])
	}
}

/**
 * (Re)opens the ARC, SETTINGS, CMC, and HEARTBEAT UDP sockets, closing any sockets/mdns/interval
 * left over from a previous call, then starts mDNS device discovery.
 */
export function initConnection(self: DanteInstance): void {
	// close any sockets/mdns/interval left over from a previous call, so re-init doesn't
	// try to rebind the fixed Settings/Heartbeat ports while the old sockets still hold them
	if (self.sockets) {
		for (const socket of Object.values(self.sockets)) {
			// 'close' (and any in-flight 'error') fires asynchronously, i.e. after this function has
			// finished rebuilding state. The handlers close over `self`, so a stale event would mark
			// the *replacement* socket inactive and flip the instance to Disconnected. Drop them first.
			socket?.removeAllListeners()
			try {
				socket?.close()
			} catch (error) {
				// closing an already-closed socket throws ERR_SOCKET_DGRAM_NOT_RUNNING - reachable
				// because destroy() closes the sockets without clearing them off the instance
				logger.debug(`Closing stale socket : ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	clearDeviceTimeouts(self)

	// a rebuild or variable push queued by the outgoing generation would publish device data we are
	// about to discard
	cancelUpdateData(self)
	cancelCheckVariables(self)
	cancelCheckFeedbacks(self)
	if (self.mdns) {
		// drop the old listeners first, so a late callback from the outgoing instance can't
		// write into the fresh state we're about to build
		self.mdns.removeAllListeners()
		self.mdns.destroy()
	}
	if (self.INTERVAL) {
		clearInterval(self.INTERVAL)
		self.INTERVAL = null
	}

	self.counter = Buffer.from('0000', 'hex')

	self.debug = self.config.verbose
	self.timeout = self.config.timeoutInterval
	self.activeConnections = {}
	self.updateStatus(InstanceStatus.Connecting)

	// create data object
	self.devicesData = {}

	// create actions and feedback dropdown choices
	self.devicesChoices = []
	self.txChannelsChoices = {}
	self.rxChannelsChoices = {}
	self.txFriendlyNameRefreshCounter = 0

	// Resolve the configured network card. Matching by MAC as well as by address means a link-local
	// or DHCP card whose address changed since the config was saved is still found.
	const available = listNetworkInterfaces()
	const resolved = resolveConfiguredInterface(self.config.mac, available)
	const boundAddress = resolved?.nic.address
	// Which interfaces to join multicast groups on: the chosen one, or all of them when automatic.
	const multicastInterfaces = boundAddress !== undefined ? [boundAddress] : available.map((nic) => nic.address)
	if (resolved?.matchedBy === 'mac') {
		logger.info(
			`Configured interface has a new address: ${resolved.nic.name} is now ${resolved.nic.address}. ` +
				`Matched it by hardware address instead.`,
		)
	}

	// An address alone cannot be upgraded to a hardware address statically - the card that held it
	// is only knowable while the address is still assigned. So rewrite the stored value here, the
	// first time a legacy configuration connects successfully, and keep it current afterwards.
	if (resolved && self.config.mac !== encodeInterfaceId(resolved.nic)) {
		const canonical = encodeInterfaceId(resolved.nic)
		logger.info(`Recording network card ${resolved.nic.name} as '${canonical}' so it survives address changes`)
		self.config = { ...self.config, mac: canonical }
		self.saveConfig(self.config)
	}

	// create communication sockets
	self.sockets = {}

	// create Dante ARC socket
	self.sockets.ARC = dgram.createSocket({ type: 'udp4', reuseAddr: true, ...REUSE_PORT_OPTION })
	const arcSocket = self.sockets.ARC

	arcSocket.on('message', (reply, rinfo) => parseReply(self, reply, rinfo))
	arcSocket.on('error', (error) => {
		logger.error(`ARC socket : ${error.message}`)
		self.activeConnections.ARC = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	arcSocket.on('close', () => {
		logger.warn('ARC socket closed')
		self.activeConnections.ARC = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	arcSocket.on('listening', () => {
		self.activeConnections.ARC = true
		checkConnections(self)
	})

	// bind socket to random port of configured ip address if available
	if (boundAddress !== undefined) {
		self.configError = null
		arcSocket.bind(0, boundAddress)
		self.mac = Buffer.from((resolved?.nic.mac ?? '').replaceAll(':', ''), 'hex')
	} else if (!self.config.mac) {
		// Automatic is a deliberate choice, not a misconfiguration. Bind the wildcard address; the
		// hardware address each command carries is resolved per device as devices are discovered.
		self.configError = null
		self.mac = Buffer.alloc(6)
		arcSocket.bind()
	} else {
		// Every settings command embeds this MAC, and devices ignore commands carrying a zero one.
		// Discovery and routing still work, but sample rate, encoding, pullup, output level and the
		// model/manufacturer variables all stay empty - which looks like the module is broken rather
		// than misconfigured. Say so explicitly, here and in the instance status.
		self.configError = 'Configured network card is not available on this machine'
		const availableLabels = available.map((nic) => `${nic.name} (${nic.address})`).join(', ')
		logger.error(
			`${self.configError}. Device settings (sample rate, encoding, pullup, output level, model info) ` +
				`will not be readable until this is fixed. Available: ${availableLabels || 'none'}`,
		)
		self.log(
			'error',
			`${self.configError} - device settings will be unavailable. Set 'Network card' in the connection config.`,
		)
		arcSocket.bind()
		self.mac = Buffer.from('000000000000', 'hex')
	}

	// create Dante settings socket
	self.sockets.SETTINGS = dgram.createSocket({ type: 'udp4', reuseAddr: true, ...REUSE_PORT_OPTION })
	const settingSocket = self.sockets.SETTINGS
	settingSocket.on('message', (reply, rinfo) => parseSettingsReply(self, reply, rinfo))

	settingSocket.on('error', (error) => {
		logger.error(`Settings socket : ${error.message}`)
		self.activeConnections.SETTINGS = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	settingSocket.on('close', () => {
		logger.warn('Settings socket closed')
		self.activeConnections.SETTINGS = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	settingSocket.on('listening', () => {
		const joined = joinMulticastGroup(settingSocket, DANTE_CONST.MULTICAST_IP.INFO, 'SETTINGS', multicastInterfaces)
		// without the group membership the socket is bound but deaf, so don't report it as active
		self.activeConnections.SETTINGS = joined
		checkConnections(self)
	})

	// Always bind to the wildcard address - a socket bound to a specific unicast interface
	// address can silently fail to receive multicast-addressed packets on some platforms
	// (e.g. macOS/BSD), since the packet's destination (the multicast group IP) won't match
	// the bound address. `addMembership` above already scopes group membership to the chosen
	// interface, so the wildcard bind doesn't widen which interface's traffic we receive.
	settingSocket.bind(DANTE_CONST.PORTS.INFO)

	// create Dante CMC socket
	self.sockets.CMC = dgram.createSocket({ type: 'udp4', reuseAddr: true, ...REUSE_PORT_OPTION })
	const cmcSocket = self.sockets.CMC
	cmcSocket.on('message', (reply, rinfo) => parseCmcReply(self, reply, rinfo))

	cmcSocket.on('error', (error) => {
		logger.error(`CMC socket : ${error.message}`)
		self.activeConnections.CMC = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	cmcSocket.on('close', () => {
		logger.warn('CMC socket closed')
		self.activeConnections.CMC = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	cmcSocket.on('listening', () => {
		self.activeConnections.CMC = true
		checkConnections(self)
	})

	if (boundAddress !== undefined) {
		cmcSocket.bind({ address: boundAddress })
	} else {
		cmcSocket.bind()
	}

	// create Dante heartbeat socket
	self.sockets.HEARTBEAT = dgram.createSocket({ type: 'udp4', reuseAddr: true, ...REUSE_PORT_OPTION })
	const heartbeatSocket = self.sockets.HEARTBEAT
	heartbeatSocket.on('message', (reply, rinfo) => parseHeartbeatReply(self, reply, rinfo))

	heartbeatSocket.on('error', (error) => {
		logger.error(`Heartbeat socket : ${error.message}`)
		self.activeConnections.HEARTBEAT = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	heartbeatSocket.on('close', () => {
		logger.warn('Heartbeat socket closed')
		self.activeConnections.HEARTBEAT = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	heartbeatSocket.on('listening', () => {
		const joined = joinMulticastGroup(
			heartbeatSocket,
			DANTE_CONST.MULTICAST_IP.HEARTBEAT,
			'HEARTBEAT',
			multicastInterfaces,
		)
		// see the SETTINGS socket above - no membership means no traffic
		self.activeConnections.HEARTBEAT = joined
		checkConnections(self)
	})

	// Always bind to the wildcard address - see the comment on the SETTINGS socket's bind above.
	heartbeatSocket.bind(DANTE_CONST.PORTS.HEARTBEAT)

	setupInterval(self)

	if (boundAddress !== undefined) {
		// `multicast-dns` binds its socket to `bind ?? interface` - passing only `interface` binds
		// to that specific unicast address, which (like our own sockets above) can silently drop
		// incoming multicast-addressed replies on macOS/BSD. Bind the socket to the wildcard address
		// explicitly, while still scoping multicast group membership to the chosen interface.
		self.mdns = multidns({ interface: boundAddress, bind: '0.0.0.0' })
	} else {
		self.mdns = multidns()
	}
	self.mdns.on('response', (response, rinfo) => danteDiscovery(self, response as unknown as MdnsResponsePacket, rinfo))

	// `multicast-dns` returns a bare EventEmitter, so an unhandled 'error' event would throw and
	// take down the module process. It only emits 'error' for EACCES/EADDRINUSE on the socket and
	// for a failed bind - all of which mean discovery is dead, so report it rather than crash.
	self.mdns.on('error', (error) => {
		logger.error(`mDNS : ${error.message}`)
		self.activeConnections.MDNS = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	// Non-fatal problems all arrive as 'warning': malformed packets from anything on the network
	// (potentially noisy, hence debug-gated) but also addMembership/setMulticastInterface failures,
	// which are the difference between "no Dante devices here" and "discovery never started".
	self.mdns.on('warning', (error) => {
		if (self.debug) {
			logger.warn(`mDNS : ${error.message}`)
		} else {
			logger.debug(`mDNS : ${error.message}`)
		}
	})

	// Fires once the socket is bound. Sends issued before this are queued by multicast-dns, so
	// the discovery query below is safe to send immediately - this only tracks liveness.
	self.mdns.on('ready', () => {
		self.activeConnections.MDNS = true
		checkConnections(self)
	})

	self.mdns.on('networkInterface', () => {
		if (self.debug) {
			logger.debug('mDNS multicast memberships updated')
		}
	})

	// dante devices discover
	getMdnsServices(self)
}

/**
 * The id to use as a dropdown's default: the first entry of the list that dropdown actually offers.
 *
 * Dropdowns whose choices are filtered must take their default from the filtered list. Defaulting
 * to the first device overall can select one the filter removed, leaving the control showing a
 * value that is not selectable and an action pointed at a device that cannot perform it.
 */
export function firstChoiceId<T extends string | number>(choices: DropdownChoice[], fallback: T): string | number {
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
export function currentChoiceId<T extends string | number>(
	choices: DropdownChoice[],
	current: string | number | undefined,
	fallback: T,
): string | number {
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
export function orPlaceholder(choices: DropdownChoice[], label: string): DropdownChoice[] {
	return choices.length > 0 ? choices : [{ id: '', label }]
}

/** Devices that have receive channels, as dropdown choices. */
export function rxDeviceChoices(self: DanteInstance): DropdownChoice[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => hasRxChannels(deviceByIdentifier(self, String(choice.id)))),
		'No devices with receive channels found',
	)
}

/** Devices that have transmit channels, as dropdown choices. */
export function txDeviceChoices(self: DanteInstance): DropdownChoice[] {
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
export function audioDeviceChoices(self: DanteInstance): DropdownChoice[] {
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
): DropdownChoice[] {
	return orPlaceholder(
		self.devicesChoices.filter((choice) => (deviceByIdentifier(self, String(choice.id))?.[options]?.length ?? 0) > 0),
		'No devices report this setting',
	)
}

/** A device's rx or tx channel choices, or an empty list if it has none yet. */
export function channelChoices(self: DanteInstance, device: DeviceData, channelType: 'rx' | 'tx'): DropdownChoice[] {
	if (!device.name) return []
	const byDevice = channelType === 'rx' ? self.rxChannelsChoices : self.txChannelsChoices
	return byDevice[device.name] ?? []
}

/** What an rx channel is currently subscribed to, as the device reports it. */
export interface RxChannelSource {
	/** Name of the transmitting device, with the '.' self-route shorthand already resolved. */
	deviceName: string
	/** Name of the transmitting channel. */
	channelName: string
}

/**
 * Reads what a device's rx channel is currently subscribed to, for the learn callbacks.
 *
 * Returns undefined when the channel is unrouted or the device is unknown, so a learn can decline
 * to change anything rather than writing empty values over the user's settings.
 *
 * A self-route is reported by the device as the '.' shorthand rather than its own name; that is
 * resolved here so callers always get a name they can match against `devicesChoices`.
 */
export function getRxChannelSource(
	self: DanteInstance,
	deviceIdentifier: string,
	channelNumber: number,
): RxChannelSource | undefined {
	const deviceIp = self.devicesData[deviceIdentifier] ? deviceIdentifier : findDeviceIpByName(self, deviceIdentifier)
	const device = deviceIp !== undefined ? self.devicesData[deviceIp] : undefined
	const channel = device?.rx?.[channelNumber]
	if (!channel?.sourceDevice || !channel.sourceChannel) {
		return undefined
	}

	return {
		deviceName: channel.sourceDevice === '.' ? (device?.name ?? channel.sourceDevice) : channel.sourceDevice,
		channelName: channel.sourceChannel,
	}
}

/**
 * Resolves a device identifier to its address.
 *
 * Accepts either a device name or an IP. Dropdowns store the name, because a device's address is
 * reassigned by DHCP and link-local autoconfiguration while its name is chosen by the user and
 * persists - but actions saved before that store an address, and those keep working through here.
 */
export function resolveDeviceIp(self: DanteInstance, identifier: string): string | undefined {
	if (!identifier) return undefined
	if (self.devicesData[identifier]) return identifier
	return findDeviceIpByName(self, identifier)
}

/** The device record behind an identifier, which may be a name or an IP. */
export function deviceByIdentifier(self: DanteInstance, identifier: string): DeviceData | undefined {
	const ip = resolveDeviceIp(self, identifier)
	return ip !== undefined ? self.devicesData[ip] : undefined
}

/** Adds a device to the `devicesChoices` dropdown list, keeping it sorted by label. */
export function insertDeviceChoice(self: DanteInstance, deviceIp: string, deviceName: string): void {
	logger.info(`INSERT DEVICE : ${deviceName}, ip : ${deviceIp}`)

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
	logger.info('UPDATE DEVICE NAME : ' + deviceName)

	// Choices are keyed by name, so a rename replaces the entry rather than relabelling it. Actions
	// referring to the old name keep their stored value - `allowCustom` lets it stay selected - but
	// will not resolve until they are pointed at the new name.
	const previousName = self.devicesData[deviceIp]?.name
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

	const channelChoice: DropdownChoice[] = [{ id: 0, label: 'None' }]
	const choicesByDevice = channelType === 'tx' ? self.txChannelsChoices : self.rxChannelsChoices
	if (channelType == 'tx') {
		for (let i = 1; i <= (ioObject.count ?? 0); i++) {
			const channelName = getChannelSubscriptionName(ioObject[i]) ?? ''
			channelChoice[i] = { id: i, label: channelName }
		}
	} else {
		for (let i = 1; i <= (ioObject.count ?? 0); i++) {
			const channelName = ioObject[i]?.name ?? ''
			channelChoice.push({ id: i, label: channelName })
		}
	}
	if (!choicesByDevice[deviceName]) {
		choicesByDevice[deviceName] = channelChoice
		scheduleUpdateData(self)
	} else {
		for (let i = 1; i < channelChoice.length; i++) {
			if (!choicesByDevice[deviceName][i] || channelChoice[i].label != choicesByDevice[deviceName][i].label) {
				choicesByDevice[deviceName] = channelChoice
				scheduleUpdateData(self)
				break
			}
		}
	}
}

/** Registers a newly-seen Dante device in `devicesData`, arming an offline timeout if configured. */
/**
 * Records which card reaches `deviceIp`, when the network card is being chosen automatically.
 *
 * Settings and CMC commands embed a hardware address and devices ignore commands carrying an
 * all-zero one, so without this an automatic configuration would discover and route but never read
 * a device's settings. Resolved per device rather than once for the instance: with Dante devices on
 * more than one network a single address is wrong for all but one of them, and which one it
 * happened to be depended on mDNS reply ordering.
 *
 * Stored as a hex string rather than a Buffer because device records pass through `merge()`.
 */
function resolveDeviceInterface(self: DanteInstance, deviceIp: string): string | undefined {
	// An explicitly chosen card is honoured for every device.
	if (self.config.mac) return undefined

	const nic = findInterfaceForAddress(listNetworkInterfaces(), deviceIp)
	if (!nic?.mac) return undefined

	logger.info(`Reaching ${deviceIp} via ${nic.name} (${nic.address})`)
	return nic.mac.replaceAll(':', '')
}

/**
 * The hardware address to put in a command addressed to `deviceIp`.
 *
 * Falls back to the instance address, which is the explicitly configured card when there is one.
 */
export function macForDevice(self: DanteInstance, device: string): Buffer {
	const deviceMac = deviceByIdentifier(self, device)?.interfaceMac
	return deviceMac ? Buffer.from(deviceMac, 'hex') : self.mac
}

export function registerDevice(self: DanteInstance, deviceIp: string, deviceName: string): DeviceData {
	self.devicesData[deviceIp] = {
		name: deviceName,
		ports: {},
		interfaceMac: resolveDeviceInterface(self, deviceIp),
	}
	const currDevice = self.devicesData[deviceIp]

	// timeout function to destroy reference if device is offline too long
	if (self.timeout > 0 && !currDevice.timeoutArray) {
		// embed timeout object into array to avoid circular references with merge function
		currDevice.timeoutArray = [
			setTimeout(() => {
				destroyDevice(self, deviceIp)
			}, self.timeout),
		]
	}

	insertDeviceChoice(self, deviceIp, deviceName)
	return currDevice
}

/**
 * Removes a device (considered offline) from `devicesData` and its associated dropdown choices,
 * then rebuilds action/feedback/variable definitions.
 */
export function destroyDevice(self: DanteInstance, deviceIp: string): void {
	const deviceName = self.devicesData[deviceIp]?.name
	logger.warn(`${deviceName} (${deviceIp}) is offline. Destroying references`)

	// delete channels name choices
	if (deviceName !== undefined) {
		delete self.rxChannelsChoices[deviceName]
		delete self.txChannelsChoices[deviceName]
	}

	// delete device choice, which is keyed by name
	if (deviceName !== undefined) {
		const index = self.devicesChoices.findIndex((choice) => choice.id === deviceName)
		if (index !== -1) {
			self.devicesChoices.splice(index, 1)
		}
	}

	//delete timeout
	clearTimeout(self.devicesData[deviceIp]?.timeoutArray?.[0])

	// delete object from devicesData
	delete self.devicesData[deviceIp]

	scheduleUpdateData(self)
}

/** Resets a device's offline timeout, keeping it from being considered offline. */
export function keepAlive(self: DanteInstance, deviceIp: string): void {
	const toArray = self.devicesData[deviceIp]?.timeoutArray
	if (toArray) {
		clearTimeout(toArray[0])
		if (self.timeout > 0) {
			toArray[0] = setTimeout(() => {
				destroyDevice(self, deviceIp)
			}, self.timeout)
		}
	}
}

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
				const encValue = DANTE_CONST.ENCODINGS[enc] ?? enc
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
				currDevice.pullup = DANTE_CONST.PULLUPS[pullup]
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
					currDevice.output_levels.push(DANTE_CONST.LEVELS[level] ?? level)
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
				refreshSettings(self, deviceIp)
				break
			}
		}
		// There was an unconditional all-devices/all-types sweep here. CMC replies only ever carry
		// service ports, and the only branch that mutates devicesData is 0x1001 above - which now
		// schedules its own scoped update (and that still refreshes the `devices` list variable).
	}
}

/**
 * Sends a pre-built Dante command buffer to a device over the correct socket/port for the given service.
 */
export function sendCommand(
	self: DanteInstance,
	command: Buffer,
	host: string,
	service: ServiceName = 'ARC',
	forcePort?: number,
): void {
	if (self.debug) {
		// Log sent bytes when in debug mode
		logger.debug(`${service} : Tx (${command.length}): ${command.toString('hex')}`)
	}

	// `host` may be a device name or an address: dropdowns store the name, older saved actions and
	// internal callers pass the address. Resolving here covers every command path at once.
	const ipaddress = resolveDeviceIp(self, host) ?? host
	const port = forcePort ?? self.devicesData[ipaddress]?.ports?.[service]
	if (port) {
		self.sockets[service]?.send(command, 0, command.length, port, ipaddress)
	} else {
		const deviceId = self.devicesData[ipaddress]?.name ?? host
		logger.error(`Undefined port for service ${service} for device ${deviceId}`)
		return
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

/** Sets the name of an rx or tx channel on a device. */
export function setChannelName(
	self: DanteInstance,
	ipaddress: string,
	channelName = '',
	channelType: 'rx' | 'tx' = 'rx',
	channelNumber = 0,
): void {
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

/**
 * Queries a device's rx/tx channel counts.
 * @returns The device's last-known channel count entry, if any (the reply itself arrives asynchronously via {@link parseReply}).
 */
export function getChannelCount(self: DanteInstance, ipaddress: string): number | undefined {
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
	for (let i = 1; i <= (device.tx?.count ?? 0); i++) {
		const channel = device.tx?.[i]
		if (channel) {
			delete channel.friendlyName
		}
	}
	sendChannelQuery(
		self,
		ipaddress,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY,
		device.tx?.count ?? 0,
		DANTE_CONST.CHANNELS_PER_PAGE.TX,
	)
}

/** Queries a device's tx channel details (names, sample rates), paginating the request 32 channels at a time. */
export function getTxChannels(self: DanteInstance, ipaddress: string): void {
	sendChannelQuery(
		self,
		ipaddress,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY,
		self.devicesData[ipaddress]?.tx?.count ?? 0,
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
	for (let page = 0; page < Math.max(1, Math.ceil(channelCount / channelsPerPage)); page++) {
		const commandArguments = Buffer.from('0001000100', 'hex')
		// The starting channel is a big-endian u16 spanning argument bytes 2-3. Writing a single byte
		// at byte 3 produced identical packets for channels 1-255 but threw ERR_OUT_OF_RANGE beyond
		// that, so a device with more than 255 channels in one direction could not be paged past the
		// first 255. Writing the full u16 is the same bytes below 256 and correct above it.
		commandArguments.writeUInt16BE(page * channelsPerPage + 1, 2)
		sendCommand(self, makeCommand(self, commandType, commandArguments), ipaddress)
	}
}

export function getRxChannels(self: DanteInstance, ipaddress: string): void {
	// rx.count, not tx.count - paging the receive query by the transmit count silently truncates
	// discovery on any device with more inputs than outputs (a 32x8 DSP would only ever report its
	// first 16 receive channels)
	sendChannelQuery(
		self,
		ipaddress,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY,
		self.devicesData[ipaddress]?.rx?.count ?? 0,
		DANTE_CONST.CHANNELS_PER_PAGE.RX,
	)
}

/** Queries a device's name. */
export function getDeviceName(self: DanteInstance, ipaddress: string): void {
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_NAME_QUERY)
	sendCommand(self, commandBuffer, ipaddress)
}

/** Queries a device's settings (sample rate, latency). */
export function getSettings(self: DanteInstance, ipaddress: string): void {
	const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_QUERY)
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

/** Queries a device's current sample rate. */
export function getSampleRate(self: DanteInstance, ipaddress: string): void {
	setSampleRate(self, ipaddress, 0)
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

/** Queries a device's current sample rate pullup setting. */
export function getPullup(self: DanteInstance, ipaddress: string): void {
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

/** Queries a device's current audio encoding. */
export function getEncoding(self: DanteInstance, ipaddress: string): void {
	setEncoding(self, ipaddress, 0)
}

/** Sets the output level for a channel on a device. */
export function setLevel(
	self: DanteInstance,
	ipaddress: string,
	_direction: 'out',
	channelNumber: number,
	levelSetting: number,
): void {
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

/** Queries a device's current output levels. */
export function getLevel(self: DanteInstance, ipaddress: string): void {
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
 * Handles an mDNS response: follows up PTR records with SRV queries, and for SRV records
 * registers/updates the announcing device and its per-service port, kicking off follow-up
 * queries (channel count/settings for ARC, settings port for CMC) when a port is newly learned.
 */
export function danteDiscovery(self: DanteInstance, response: MdnsResponsePacket, rinfo: dgram.RemoteInfo): void {
	const answers = [...response.answers, ...response.additionals]
	answers.forEach((answer) => {
		const name = answer.name
		// get devices and services names and port
		if (answer.type == 'PTR' && DANTE_CONST.SERVICES_ARRAY.includes(name)) {
			self.mdns.query(
				{
					questions: [
						{
							name: answer.data,
							type: 'SRV',
						},
					],
				},
				(error) => {
					if (error) {
						logger.warn(`mDNS SRV query for ${answer.data} failed : ${error.message}`)
					}
				},
			)
		} else if (answer.type == 'SRV') {
			// register services and port
			for (const [id, danteService] of Object.entries(DANTE_CONST.SERVICES)) {
				const dotIndex = name.indexOf('.')
				const deviceName = name.slice(0, dotIndex)
				const serviceName = name.slice(dotIndex + 1)

				if (serviceName == danteService) {
					const deviceIp = rinfo.address
					let currDevice = self.devicesData[deviceIp]

					if (currDevice) {
						keepAlive(self, deviceIp)
					} else {
						// create data object if needed
						currDevice = registerDevice(self, deviceIp, deviceName)
						scheduleUpdateData(self)
					}

					if (currDevice.name != deviceName) {
						currDevice.name = deviceName
						updateDeviceChoice(self, deviceIp, deviceName)
						scheduleUpdateData(self)
					}
					if (!currDevice.ports) {
						currDevice.ports = {}
					}

					const serviceId = id as ServiceName
					if (currDevice.ports[serviceId] != answer.data.port) {
						logger.info(`Port for service ${serviceId} of device ${deviceName} is : ${answer.data.port}`)
						currDevice.ports[serviceId] = answer.data.port

						switch (serviceId) {
							case 'ARC':
								getChannelCount(self, deviceIp)
								getSettings(self, deviceIp)
								break

							case 'CMC':
								getSettingsPort(self, deviceIp)
								break
						}
					}
				}
			}
		}
	})
}

/**
 * (Re)starts the periodic mDNS device-discovery poll, per `config.interval`. Stops any existing
 * interval first; does nothing further if `config.interval` is 0.
 */
export function setupInterval(self: DanteInstance): void {
	stopInterval(self)

	if (self.config.interval > 0) {
		self.INTERVAL = setInterval(() => void getMdnsServices(self), self.config.interval)
		logger.info('Starting Update Interval: Every ' + self.config.interval + 'ms')
	}
}

/** Stops the periodic mDNS device-discovery poll, if running. */
export function stopInterval(self: DanteInstance): void {
	if (self.INTERVAL !== null) {
		logger.info('Stopping Update Interval.')
		clearInterval(self.INTERVAL)
		self.INTERVAL = null
	}
}

/**
 * Re-queries SETTINGS-service parameters (sample rate, pullup, encoding, level, versions) for
 * one device, or all known devices if none is given.
 */
export function refreshSettings(self: DanteInstance, deviceIp?: string): void {
	const ipArray = deviceIp ? [deviceIp] : Object.keys(self.devicesData)
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
	for (const ip of ipArray) {
		getDeviceName(self, ip)
		getSettings(self, ip)
		getRxChannels(self, ip)
		getTxChannels(self, ip)
		getTxChannelFriendlyNames(self, ip)
	}
}

/** Sends an mDNS query for all Dante service types, to discover devices on the network. */
export function getMdnsServices(self: DanteInstance): void {
	if (self.debug) {
		logger.debug('Mdns discovery')
	}

	const questions = DANTE_CONST.SERVICES_ARRAY.map((service) => ({
		name: service,
		type: 'PTR' as const,
	}))

	self.mdns?.query(
		{
			questions: questions,
		},
		(error) => {
			if (error) {
				logger.warn(`mDNS discovery query failed : ${error.message}`)
			}
		},
	)
}

/**
 * How long the definition rebuild waits for the flurry of discovery replies to settle.
 * Long enough to coalesce a device's registration, name, and paged channel replies into one
 * rebuild; short enough that a single device appearing still feels immediate.
 */
const UPDATE_DEBOUNCE_MS = 500

/**
 * Upper bound on how long a rebuild can be deferred. On a large network the replies never stop
 * arriving for long enough to reach the debounce window, so without this the dropdowns would
 * stay empty for the whole of discovery. This guarantees visible progress every 10s instead.
 */
const UPDATE_MAX_WAIT_MS = 10_000

/** One debounced rebuild per instance. Weakly held so a discarded instance is still collectable. */
const debouncedUpdates = new WeakMap<DanteInstance, DebouncedFunc<() => void>>()

function getDebouncedUpdate(self: DanteInstance): DebouncedFunc<() => void> {
	let debounced = debouncedUpdates.get(self)
	if (!debounced) {
		debounced = debounce(() => updateData(self), UPDATE_DEBOUNCE_MS, { maxWait: UPDATE_MAX_WAIT_MS })
		debouncedUpdates.set(self, debounced)
	}
	return debounced
}

/**
 * Requests a definition rebuild, coalescing bursts of requests into a single one.
 *
 * Discovery calls this once per device registration, once per name, and once per 32-channel page
 * in each direction, while every rebuild re-serialises the definitions for *all* devices to the
 * Companion host - so the uncoalesced cost is quadratic in network size. Prefer this over calling
 * `updateData` directly for anything on the discovery path.
 */
export function scheduleUpdateData(self: DanteInstance): void {
	getDebouncedUpdate(self)()
}

/** Drops any pending rebuild, for when the state it would publish is being torn down or replaced. */
export function cancelUpdateData(self: DanteInstance): void {
	debouncedUpdates.get(self)?.cancel()
}

/** Runs any pending rebuild immediately. */
export function flushUpdateData(self: DanteInstance): void {
	debouncedUpdates.get(self)?.flush()
}

/**
 * How often variable values may be pushed to Companion. Short enough that a fader move or a
 * subscription change still feels instant, long enough to collapse the burst of per-channel-page
 * replies a single device emits into one push.
 */
const VARIABLES_THROTTLE_MS = 30

/**
 * Pending variable work, accumulated between throttle ticks.
 *
 * A plain `throttle(CheckVariables)` would be wrong: throttling invokes with the *last* arguments,
 * so a scoped update for device A arriving just before one for device B would silently discard A.
 * Instead every request is unioned in here and the tick applies the combined result.
 */
interface PendingVariables {
	ips: Set<string>
	/** A request arrived with no IP, so every device needs refreshing. */
	allDevices: boolean
	types: Set<string>
	/** A request arrived with no explicit types, so every category needs refreshing. */
	allTypes: boolean
}

const pendingVariables = new WeakMap<DanteInstance, PendingVariables>()
const throttledVariables = new WeakMap<DanteInstance, DebouncedFunc<() => void>>()

function flushCheckVariables(self: DanteInstance): void {
	const pending = pendingVariables.get(self)
	if (!pending) return
	pendingVariables.delete(self)

	const types = pending.allTypes ? [] : [...pending.types]

	// Collapse to a single unscoped sweep once more than one device is waiting: CheckVariables walks
	// every device regardless (to rebuild the `devices` list), so N scoped calls cost about the same
	// as one unscoped call but push N separate setVariableValues payloads instead of one.
	if (pending.allDevices || pending.ips.size > 1) {
		CheckVariables(self, undefined, ...types)
	} else if (pending.ips.size === 1) {
		CheckVariables(self, [...pending.ips][0], ...types)
	}
}

function getThrottledVariables(self: DanteInstance): DebouncedFunc<() => void> {
	let throttled = throttledVariables.get(self)
	if (!throttled) {
		throttled = throttle(() => flushCheckVariables(self), VARIABLES_THROTTLE_MS, {
			// leading so the first change in a quiet period lands immediately, trailing so the last
			// change in a busy one is never dropped
			leading: true,
			trailing: true,
		})
		throttledVariables.set(self, throttled)
	}
	return throttled
}

/**
 * Requests a variable refresh, coalescing requests within {@link VARIABLES_THROTTLE_MS} into a
 * single push to Companion. Arguments match {@link CheckVariables} and are unioned across the
 * window rather than overwritten.
 */
export function scheduleCheckVariables(self: DanteInstance, ipAddress?: string, ...variableTypes: string[]): void {
	let pending = pendingVariables.get(self)
	if (!pending) {
		pending = { ips: new Set(), allDevices: false, types: new Set(), allTypes: false }
		pendingVariables.set(self, pending)
	}

	if (ipAddress === undefined) {
		pending.allDevices = true
	} else {
		pending.ips.add(ipAddress)
	}

	if (variableTypes.length === 0) {
		pending.allTypes = true
	} else {
		for (const variableType of variableTypes) {
			pending.types.add(variableType)
		}
	}

	getThrottledVariables(self)()
}

/** Drops any pending variable refresh, for when the state it would publish is going away. */
export function cancelCheckVariables(self: DanteInstance): void {
	throttledVariables.get(self)?.cancel()
	pendingVariables.delete(self)
}

/**
 * Which devices each live feedback instance depends on, keyed by feedback instance id.
 *
 * Both routing feedbacks read two devices: the destination (its rx channel's subscription status
 * and source labels) and the source (its tx channel's name/friendlyName/number, used to match
 * against what the destination reports). So a change to *either* device can flip the result, and
 * indexing on destination alone would leave feedbacks stale whenever a source device renamed a
 * transmit channel.
 */
const feedbackDevices = new WeakMap<DanteInstance, Map<string, Set<string>>>()

/**
 * Feedbacks whose devices could not be resolved - a manual feedback naming a device that is not
 * discovered yet, or whose name came from a variable that does not resolve. They are checked on
 * every tick, since we cannot tell whether they are affected.
 */
const wildcardFeedbacks = new WeakMap<DanteInstance, Set<string>>()

interface PendingFeedbacks {
	devices: Set<string>
	/** Something changed that is not attributable to one device, so check everything. */
	allDevices: boolean
}

const pendingFeedbacks = new WeakMap<DanteInstance, PendingFeedbacks>()
const throttledFeedbacks = new WeakMap<DanteInstance, DebouncedFunc<() => void>>()

/**
 * Records which devices a feedback instance depends on, so later changes to those devices can
 * re-check just this feedback instead of every feedback of its type.
 *
 * Called from the feedback callbacks, which are the only place the resolved device identities are
 * known - `@companion-module/base` 2.x has no `subscribe` hook. Companion re-runs a callback when
 * its options or referenced variables change, so the mapping stays current.
 *
 * @param deviceIps The devices this feedback reads; any `undefined` entry marks it as a wildcard.
 */
export function trackFeedbackDevices(self: DanteInstance, feedbackId: string, deviceIps: (string | undefined)[]): void {
	let byId = feedbackDevices.get(self)
	if (!byId) {
		byId = new Map()
		feedbackDevices.set(self, byId)
	}

	let wildcards = wildcardFeedbacks.get(self)
	if (!wildcards) {
		wildcards = new Set()
		wildcardFeedbacks.set(self, wildcards)
	}

	const resolved = new Set<string>()
	let unresolved = false
	for (const ip of deviceIps) {
		if (ip) {
			resolved.add(ip)
		} else {
			unresolved = true
		}
	}

	byId.set(feedbackId, resolved)
	if (unresolved) {
		wildcards.add(feedbackId)
	} else {
		wildcards.delete(feedbackId)
	}
}

/** Forgets a feedback instance that Companion has removed or disabled. */
export function untrackFeedback(self: DanteInstance, feedbackId: string): void {
	feedbackDevices.get(self)?.delete(feedbackId)
	wildcardFeedbacks.get(self)?.delete(feedbackId)
}

function flushCheckFeedbacks(self: DanteInstance): void {
	const pending = pendingFeedbacks.get(self)
	if (!pending) return
	pendingFeedbacks.delete(self)

	const byId = feedbackDevices.get(self)

	// Nothing tracked yet means no feedback callback has run, so we have no ids to target. Fall back
	// to the type-level check, which is also what a full rebuild wants.
	if (pending.allDevices || !byId || byId.size === 0) {
		self.checkAllFeedbacks()
		return
	}

	// A Set, not an array: a wildcard feedback is also present in `byId` (one end resolved, the other
	// not), so it would otherwise be emitted twice whenever its resolved device is the one that changed.
	const ids = new Set<string>(wildcardFeedbacks.get(self))
	for (const [feedbackId, devices] of byId) {
		for (const deviceIp of devices) {
			if (pending.devices.has(deviceIp)) {
				ids.add(feedbackId)
				break
			}
		}
	}

	if (ids.size > 0) {
		self.checkFeedbacksById(...ids)
	}
}

function getThrottledFeedbacks(self: DanteInstance): DebouncedFunc<() => void> {
	let throttled = throttledFeedbacks.get(self)
	if (!throttled) {
		throttled = throttle(() => flushCheckFeedbacks(self), VARIABLES_THROTTLE_MS, {
			leading: true,
			trailing: true,
		})
		throttledFeedbacks.set(self, throttled)
	}
	return throttled
}

/**
 * Requests a feedback re-check, coalescing requests within {@link VARIABLES_THROTTLE_MS}.
 *
 * @param deviceIp The device whose data changed. Omit to re-check every feedback, for changes that
 * are not attributable to a single device (such as a full definitions rebuild).
 */
export function scheduleCheckFeedbacks(self: DanteInstance, deviceIp?: string): void {
	let pending = pendingFeedbacks.get(self)
	if (!pending) {
		pending = { devices: new Set(), allDevices: false }
		pendingFeedbacks.set(self, pending)
	}

	if (deviceIp === undefined) {
		pending.allDevices = true
	} else {
		pending.devices.add(deviceIp)
	}

	getThrottledFeedbacks(self)()
}

/** Drops any pending feedback re-check, for when the state it would evaluate is going away. */
export function cancelCheckFeedbacks(self: DanteInstance): void {
	throttledFeedbacks.get(self)?.cancel()
	pendingFeedbacks.delete(self)
}

/** Rebuilds and re-registers this instance's actions, variables, and feedbacks after device data changes. */
export function updateData(self: DanteInstance): void {
	UpdateActions(self)
	UpdateVariableDefinitions(self)
	CheckVariables(self)
	UpdateFeedbacks(self)
	// a full rebuild is not attributable to one device
	scheduleCheckFeedbacks(self)
}
