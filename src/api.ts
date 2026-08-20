import multidns from 'multicast-dns'
import dgram from 'node:dgram'
import merge from './utils/merge.js'
import { networkInterfaces } from 'node:os'
import { InstanceStatus, Regex, createModuleLogger, type DropdownChoice } from '@companion-module/base'
import { DANTE_CONST } from './const.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdateVariableDefinitions, CheckVariables } from './variables.js'
import type DanteInstance from './main.js'

const logger = createModuleLogger('api')

//**
//** Types
//**

export type ServiceName = 'ARC' | 'SETTINGS' | 'CMC' | 'HEARTBEAT'

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
function intToBuffer(value: number, bytes: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 2): Buffer {
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
function bufferToInt(buffer: Buffer, offset = 0, bytes: 1 | 2 | 4 = 2): number {
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
function incrementBE(buffer: Buffer): void {
	for (let i = buffer.length - 1; i >= 0; i--) {
		if (buffer[i]++ !== 255) break
	}
}

/** Reads a NUL-terminated UTF-8 string out of a Dante message buffer. */
function parseString(buffer: Buffer, startIndex: number): string | undefined {
	const end = buffer.indexOf(0x00, startIndex)
	if (buffer.length > startIndex) {
		return buffer.toString('utf8', startIndex, end)
	}
	return undefined
}

//**
//** Dante messages parsing
//**

/** Parses a channel-count-query reply into tx/rx channel counts. */
function parseChannelCount(reply: Buffer): Partial<DeviceData> {
	return { tx: { count: reply[13] }, rx: { count: reply[15] } }
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
	for (let i = 0; i < Math.min(recCount, 32); i++) {
		// get info chunk of channel
		const infoIndex = startIndex + infoBufferSize * i
		const infoBuffer = reply.subarray(infoIndex, infoIndex + infoBufferSize)
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset)
		const nameIndex = bufferToInt(infoBuffer, friendlyNameIndexOffset)

		// create return object if needed
		if (tx[nameNumber] == undefined) {
			tx[nameNumber] = { number: nameNumber }
		}
		const returnChannel = tx[nameNumber]

		// get name
		returnChannel.friendlyName = parseString(reply, nameIndex)
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
	for (let i = 0; i < Math.min(recCount, 32); i++) {
		// get info chunk of channel
		const infoIndex = startIndex + infoBufferSize * i
		const infoBuffer = reply.subarray(infoIndex, infoIndex + infoBufferSize)
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset)
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset)

		// create return object if needed
		if (tx[nameNumber] == undefined) {
			tx[nameNumber] = { number: nameNumber }
		}
		const returnChannel = tx[nameNumber]

		// get name
		returnChannel.name = parseString(reply, nameIndex)

		// get sampleRate
		const sampleRateIndex = bufferToInt(infoBuffer, sampleRateOffset)
		if (i == 0) {
			firstChannelGroup = sampleRateIndex
		} else if (sampleRateIndex != firstChannelGroup) {
			tx.count = i
			break
		}
		returnChannel.sampleRate = reply.readUInt32BE(sampleRateIndex)
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
	for (let i = 0; i < Math.min(recCount, 32); i++) {
		// get info chunk of channel
		const infoIndex = startIndex + infoBufferSize * i
		const infoBuffer = reply.subarray(infoIndex, infoIndex + infoBufferSize)
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset)
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset)

		// create return object if needed
		if (rx[nameNumber] == undefined) {
			rx[nameNumber] = { number: nameNumber }
		}
		const returnChannel = rx[nameNumber]

		// get name
		returnChannel.name = parseString(reply, nameIndex)

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
		returnChannel.sourceChannel = parseString(reply, sourceChannelIndex)
		returnChannel.sourceDevice = parseString(reply, sourceDeviceIndex)
		returnChannel.channelStatus = bufferToInt(infoBuffer, channelStatusOffset)
		returnChannel.subscriptionStatus = bufferToInt(infoBuffer, subscriptionStatusOffset)
		returnChannel.sampleRate = reply.readUInt32BE(sampleRateIndex)
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
 * Re-evaluates overall connection status from the ARC/CMC/SETTINGS/HEARTBEAT socket states
 * and updates the instance status accordingly.
 * @returns True if all sockets are active.
 */
export function checkConnections(self: DanteInstance): boolean {
	const services: ServiceName[] = ['ARC', 'CMC', 'SETTINGS', 'HEARTBEAT']
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
		self.updateStatus(InstanceStatus.Ok)
	}
	return true
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
			socket?.close()
		}
	}
	if (self.mdns) {
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

	// get available Ips
	const nets = networkInterfaces()
	const availableIps: string[] = []
	const availableMacs: Record<string, string> = {}
	for (const name of Object.keys(nets)) {
		for (const net of nets[name] ?? []) {
			// Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses.
			// @types/node still types `family` as the literal 'IPv4'/'IPv6', but on Node 18+ it is
			// actually reported as the number 4 or 6 at runtime - check against whichever this Node returns.
			const familyV4Value: string | number = typeof net.family === 'string' ? 'IPv4' : 4
			if ((net.family as unknown as string | number) === familyV4Value && !net.internal) {
				availableIps.push(net.address)
				availableMacs[net.address] = net.mac
			}
		}
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
	if (availableIps.includes(self.config.ip)) {
		arcSocket.bind(0, self.config.ip)
		self.mac = Buffer.from((availableMacs[self.config.ip] ?? '').replaceAll(':', ''), 'hex')
	} else {
		logger.warn('Config IP not available')
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
		if (availableIps.includes(self.config.ip)) {
			settingSocket.addMembership(DANTE_CONST.MULTICAST_IP.INFO, self.config.ip)
		} else {
			settingSocket.addMembership(DANTE_CONST.MULTICAST_IP.INFO)
		}
		self.activeConnections.SETTINGS = true
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

	if (availableIps.includes(self.config.ip)) {
		cmcSocket.bind({ address: self.config.ip })
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
		if (availableIps.includes(self.config.ip)) {
			heartbeatSocket.addMembership(DANTE_CONST.MULTICAST_IP.HEARTBEAT, self.config.ip)
		} else {
			heartbeatSocket.addMembership(DANTE_CONST.MULTICAST_IP.HEARTBEAT)
		}
		self.activeConnections.HEARTBEAT = true
		checkConnections(self)
	})

	// Always bind to the wildcard address - see the comment on the SETTINGS socket's bind above.
	heartbeatSocket.bind(DANTE_CONST.PORTS.HEARTBEAT)

	setupInterval(self)

	if (availableIps.includes(self.config.ip)) {
		// `multicast-dns` binds its socket to `bind ?? interface` - passing only `interface` binds
		// to that specific unicast address, which (like our own sockets above) can silently drop
		// incoming multicast-addressed replies on macOS/BSD. Bind the socket to the wildcard address
		// explicitly, while still scoping multicast group membership to the chosen interface.
		self.mdns = multidns({ interface: self.config.ip, bind: '0.0.0.0' })
	} else {
		self.mdns = multidns()
	}
	self.mdns.on('response', (response, rinfo) => danteDiscovery(self, response as unknown as MdnsResponsePacket, rinfo))

	// dante devices discover
	getMdnsServices(self)
}

/** Adds a device to the `devicesChoices` dropdown list, keeping it sorted by label. */
export function insertDeviceChoice(self: DanteInstance, deviceIp: string, deviceName: string): void {
	logger.info(`INSERT DEVICE : ${deviceName}, ip : ${deviceIp}`)

	self.devicesChoices.push({ id: deviceIp, label: deviceName })
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

	for (const device of self.devicesChoices) {
		if (device.id == deviceIp) {
			if (device.label != deviceName) {
				device.label = deviceName
				self.devicesChoices.sort((deviceA, deviceB) => {
					return deviceA.label.localeCompare(deviceB.label)
				})
				updateData(self)
			}
			break
		}
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
		updateData(self)
	} else {
		for (let i = 1; i < channelChoice.length; i++) {
			if (!choicesByDevice[deviceName][i] || channelChoice[i].label != choicesByDevice[deviceName][i].label) {
				choicesByDevice[deviceName] = channelChoice
				updateData(self)
				break
			}
		}
	}
}

/** Registers a newly-seen Dante device in `devicesData`, arming an offline timeout if configured. */
export function registerDevice(self: DanteInstance, deviceIp: string, deviceName: string): DeviceData {
	self.devicesData[deviceIp] = { name: deviceName, ports: {} }
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

	// delete device choice
	for (let i = 0; i < self.devicesChoices.length; i++) {
		if (self.devicesChoices[i].id == deviceIp) {
			self.devicesChoices.splice(i, 1)
			break
		}
	}

	//delete timeout
	clearTimeout(self.devicesData[deviceIp]?.timeoutArray?.[0])

	// delete object from devicesData
	delete self.devicesData[deviceIp]

	updateData(self)
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
					updateData(self)
					break
				case 'info':
					CheckVariables(self, deviceIp, 'sr', 'latency')
					break
				case 'rx':
					CheckVariables(self, deviceIp, 'rx', 'rx_names')
					updateChannelChoices(self, deviceIp, 'rx')
					self.checkFeedbacks('routing_bg', 'routing_bg_manual')
					break
				case 'tx':
					CheckVariables(self, deviceIp, 'tx', 'tx_names')
					updateChannelChoices(self, deviceIp, 'tx')
					self.checkFeedbacks('routing_bg', 'routing_bg_manual')
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
		CheckVariables(self, deviceIp)
		CheckVariables(self, deviceIp, ...updateFlags)

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
				CheckVariables(self, deviceIp)
				refreshSettings(self, deviceIp)
				break
			}
		}

		CheckVariables(self)
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

	const port = forcePort ?? self.devicesData[host]?.ports?.[service]
	if (port) {
		self.sockets[service]?.send(command, 0, command.length, port, host)
	} else {
		const deviceId = self.devicesData[host]?.name ?? host
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
): Buffer {
	const commandLength = intToBuffer(commandArguments.length + 28)
	const startBlock = Buffer.from('2a84', 'hex')

	const payload = Buffer.concat([
		intToBuffer(DANTE_CONST.PROTOCOL.SETTINGS),
		commandLength,
		self.counter,
		startBlock,
		self.mac,
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
			Buffer.from('040100000', 'hex'),
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
	const channelNameBuffer = Buffer.from(channelName, 'ascii')
	const channelNumberBuffer = intToBuffer(channelNumber)

	const commandArguments = Buffer.concat([
		Buffer.from('040100000', 'hex'),
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
	const commandArguments = Buffer.from('0001000100', 'hex')
	for (let page = 0; page <= Math.ceil((device.tx?.count ?? 0) / 32); page++) {
		commandArguments.writeUInt8(page * 32 + 1, 3)
		const commandBuffer = makeCommand(
			self,
			DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY,
			commandArguments,
		)
		sendCommand(self, commandBuffer, ipaddress)
	}
}

/** Queries a device's tx channel details (names, sample rates), paginating the request 32 channels at a time. */
export function getTxChannels(self: DanteInstance, ipaddress: string): void {
	const commandArguments = Buffer.from('0001000100', 'hex')
	for (let page = 0; page <= Math.ceil((self.devicesData[ipaddress]?.tx?.count ?? 0) / 32); page++) {
		commandArguments.writeUInt8(page * 32 + 1, 3)
		const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY, commandArguments)
		sendCommand(self, commandBuffer, ipaddress)
	}
}

/** Queries a device's rx channel details (names, routing, subscription status), paginating the request 16 channels at a time. */
export function getRxChannels(self: DanteInstance, ipaddress: string): void {
	const commandArguments = Buffer.from('0001000100', 'hex')
	for (let page = 0; page <= (self.devicesData[ipaddress]?.tx?.count ?? 0) / 16; page++) {
		commandArguments.writeUInt8(page * 16 + 1, 3)
		const commandBuffer = makeCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY, commandArguments)
		sendCommand(self, commandBuffer, ipaddress)
	}
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

	const commandBuffer = makeSettingCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_ENCODING_CONTROL, commandArguments)
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

	const commandBuffer = makeSettingCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_CONTROL, commandArguments)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Queries a device's current output levels. */
export function getLevel(self: DanteInstance, ipaddress: string): void {
	const commandBuffer = makeSettingCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_CONTROL, intToBuffer(0, 4))
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Queries a device's manufacturer/model version info. */
export function getManfVersion(self: DanteInstance, ipaddress: string): void {
	const commandBuffer = makeSettingCommand(
		self,
		DANTE_CONST.COMMANDS.MESSAGE_TYPE_MANF_VERSIONS_QUERY,
		intToBuffer(0, 4),
	)
	sendCommand(self, commandBuffer, ipaddress, 'SETTINGS')
}

/** Queries a device's Dante firmware/product version info. */
export function getVersion(self: DanteInstance, ipaddress: string): void {
	const commandBuffer = makeSettingCommand(self, DANTE_CONST.COMMANDS.MESSAGE_TYPE_VERSIONS_QUERY, intToBuffer(0, 4))
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
		self.mac,
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
			self.mdns.query({
				questions: [
					{
						name: answer.data,
						type: 'SRV',
					},
				],
			})
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
						updateData(self)
					}

					if (currDevice.name != deviceName) {
						currDevice.name = deviceName
						updateDeviceChoice(self, deviceIp, deviceName)
						updateData(self)
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

	self.mdns?.query({
		questions: questions,
	})
}

/** Rebuilds and re-registers this instance's actions, variables, and feedbacks after device data changes. */
export function updateData(self: DanteInstance): void {
	UpdateActions(self)
	UpdateVariableDefinitions(self)
	CheckVariables(self)
	UpdateFeedbacks(self)
	self.checkFeedbacks('routing_bg', 'routing_bg_manual')
}
