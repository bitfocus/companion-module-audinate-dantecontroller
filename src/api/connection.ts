/**
 * The network connection: sockets, discovery, and their lifecycle.
 */

import multidns from 'multicast-dns'
import dgram from 'node:dgram'
import { InstanceStatus, createModuleLogger } from '@companion-module/base'
import { DANTE_CONST } from './const.js'
import {
	listNetworkInterfaces,
	resolveConfiguredInterface,
	encodeInterfaceId,
	effectiveTimeout,
	type NetworkInterfaceInfo,
} from '../config.js'
import type DanteInstance from '../main.js'
import type { ConnectionName, ServiceName, DanteSockets, MdnsResponsePacket } from './types.js'
import {
	cancelCheckFeedbacks,
	cancelCheckVariables,
	cancelUpdateData,
	clearDeviceTimeouts,
	resolveDeviceIp,
} from './devices.js'
import { parseAvReply, parseCmcReply, parseHeartbeatReply, parseReply, parseSettingsReply } from './protocol.js'
import { danteDiscovery, getMdnsServices } from './discovery.js'

const logger = createModuleLogger('api:connection')

// dgram's reusePort option wraps SO_REUSEPORT, which Node/libuv only supports on Linux -
// requesting it on macOS/BSD throws ENOTSUP regardless of bind address (confirmed: it fails
// the same way whether bound to a specific interface or the wildcard address), so only
// request it on Linux.
const REUSE_PORT_OPTION: { reusePort?: true } = process.platform === 'linux' ? { reusePort: true } : {}

//**
//** utils functions to parse dante messages
//**

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
 * The module's network connection: the four UDP sockets, mDNS discovery, and the state that says
 * whether they are usable.
 *
 * This is the one genuinely stateful part of the Dante API, and the part where the bugs were:
 * sockets closed twice, listeners left attached across a re-init, timers outliving the instance,
 * a status overwritten moments after being set. Gathering it behind `open`/`close` makes those
 * invariants enforceable in one place rather than spread across free functions.
 *
 * Everything else in this folder stays a plain function taking the instance, per the architecture
 * note on `DanteInstance`.
 */
export class DanteConnection {
	sockets: DanteSockets = {}
	mdns?: multidns.MulticastDNS
	activeConnections: Partial<Record<ConnectionName, boolean>> = {}
	/** True once every socket and discovery are up. */
	connected = false
	/** Why the configured network card is unusable, or null when it is fine. */
	configError: string | null = null
	/** Transaction counter shared by every command this connection sends. */
	counter: Buffer = Buffer.alloc(2)
	/** Hardware address of the chosen card, or all-zero when it is resolved per device. */
	mac: Buffer = Buffer.alloc(6)
	/**
	 * The explicitly chosen network card, or undefined when the card is chosen automatically.
	 *
	 * The sockets that receive multicast are bound to the wildcard address, so the OS hands them
	 * traffic that arrived on any card - `addMembership` scopes the group join, not the delivery.
	 * Discovery uses this to drop what came in on a card the user did not pick.
	 */
	boundInterface?: NetworkInterfaceInfo
	/** Off-card sources already reported, so that news is logged once rather than once per packet. */
	readonly ignoredSources = new Set<string>()
	/**
	 * Receive-only listener for the SETTINGS multicast group, present only when a card is chosen.
	 *
	 * `sockets.SETTINGS` then binds the card's own address so its unicast replies cannot be taken by
	 * another instance of this module on the same host, which leaves it unable to see the group - so
	 * the group gets a wildcard-bound socket of its own. See the binds in `initConnection`.
	 */
	settingsMulticast?: dgram.Socket
	interval: NodeJS.Timeout | null = null

	constructor(private readonly self: DanteInstance) {}

	/** (Re)opens the sockets and starts discovery, replacing anything a previous call left behind. */
	open(): void {
		initConnection(this.self)
	}

	/** Closes the sockets and stops discovery and every timer this connection started. */
	close(): void {
		this.stopInterval()

		for (const socket of Object.values(this.sockets)) {
			// 'close' fires async, and its handler would report a status for a connection that is
			// going away - drop the listeners first
			socket?.removeAllListeners()
			try {
				socket?.close()
			} catch {
				// already closed - nothing to do on teardown
			}
		}
		this.sockets = {}

		if (this.settingsMulticast) {
			// same reasoning as the sockets above - drop the listeners before closing
			this.settingsMulticast.removeAllListeners()
			try {
				this.settingsMulticast.close()
			} catch {
				// already closed - nothing to do on teardown
			}
			this.settingsMulticast = undefined
		}

		this.boundInterface = undefined
		this.ignoredSources.clear()

		if (this.mdns) {
			this.mdns.removeAllListeners()
			this.mdns.destroy()
			this.mdns = undefined
		}
	}

	/** Sends a prepared command to a device, over the socket and port for the given service. */
	send(command: Buffer, host: string, service: ServiceName = 'ARC', forcePort?: number): void {
		sendCommand(this.self, command, host, service, forcePort)
	}

	/** Re-evaluates whether every socket and discovery are up, and updates the instance status. */
	checkStatus(): boolean {
		return checkConnections(this.self)
	}

	/** Starts the periodic discovery sweep, replacing any existing one. */
	startInterval(): void {
		this.stopInterval()

		const period = this.self.config?.interval ?? 0
		if (period > 0) {
			this.interval = setInterval(() => getMdnsServices(this.self), period)
			// module plumbing rather than network news - the same call as the port announcements
			if (this.self.debug) {
				logger.debug('Starting Update Interval: Every ' + period + 'ms')
			}
		}
	}

	/** Stops the periodic discovery sweep. */
	stopInterval(): void {
		if (this.interval !== null) {
			if (this.self.debug) {
				logger.debug('Stopping Update Interval.')
			}
			clearInterval(this.interval)
			this.interval = null
		}
	}
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
 * (Re)opens the ARC, SETTINGS, CMC, and HEARTBEAT UDP sockets, closing any sockets/mdns/interval
 * left over from a previous call, then starts mDNS device discovery.
 */
export function initConnection(self: DanteInstance): void {
	// Tear down anything a previous call left behind, so re-init does not try to rebind the fixed
	// Settings/Heartbeat ports while the old sockets still hold them. `close()` is the same teardown
	// the instance runs on destroy - one implementation, so the two paths cannot drift.
	self.connection.close()

	clearDeviceTimeouts(self)

	// a rebuild or variable push queued by the outgoing generation would publish device data we are
	// about to discard
	cancelUpdateData(self)
	cancelCheckVariables(self)
	cancelCheckFeedbacks(self)

	self.counter = Buffer.from('0000', 'hex')

	self.debug = self.config.verbose
	// Never less than two poll intervals - see `effectiveTimeout`. The config panel shows a warning
	// alongside the field whenever this overrides what was configured.
	self.timeout = effectiveTimeout(self.config)

	if (self.timeout !== self.config.timeoutInterval) {
		logger.warn(
			`Timeout Interval (${self.config.timeoutInterval}ms) is less than twice the Update Interval ` +
				`(${self.config.interval}ms). Devices that do not send heartbeats could drop and reappear ` +
				`between polls, so ${self.timeout}ms is being used instead.`,
		)
	}
	self.activeConnections = {}
	self.updateStatus(InstanceStatus.Connecting)

	// create data object
	self.devicesData = {}

	// create actions and feedback dropdown choices
	self.devicesChoices = []
	self.txChannelsChoices = {}
	self.rxChannelsChoices = {}
	self.videoTxChannelsChoices = {}
	self.videoRxChannelsChoices = {}
	self.txFriendlyNameRefreshCounter = 0

	// Resolve the configured network card. Matching by MAC as well as by address means a link-local
	// or DHCP card whose address changed since the config was saved is still found.
	const available = listNetworkInterfaces()
	const resolved = resolveConfiguredInterface(self.config.mac, available)
	const boundAddress = resolved?.nic.address
	// Which interfaces to join multicast groups on: the chosen one, or all of them when automatic.
	const multicastInterfaces = boundAddress !== undefined ? [boundAddress] : available.map((nic) => nic.address)
	// Joining a group on one card does not stop the OS delivering that group's traffic from another
	// card to a wildcard-bound socket, so discovery filters by subnet instead - see `danteDiscovery`.
	// `resolved` is undefined unless a card was explicitly chosen, which is exactly when to filter.
	self.connection.boundInterface = resolved?.nic
	if (resolved?.matchedBy === 'mac') {
		logger.info(
			`Configured interface has a new address: ${resolved.nic.name} is now ${resolved.nic.address}. ` +
				`Matched it by hardware address instead.`,
		)
	}

	// Which card a connection ended up on decides which devices it can see, and until now the only
	// card the log ever named was one it could not find - so a connection quietly discovering a
	// neighbouring network looked identical to one working correctly. Say it either way.
	if (resolved) {
		logger.info(
			`Bound to network card ${resolved.nic.name} (${resolved.nic.address}/${resolved.nic.netmask}) - ` +
				`only devices on that subnet will be discovered`,
		)
	} else if (!self.config.mac) {
		const availableLabels = available.map((nic) => `${nic.name} (${nic.address})`).join(', ')
		logger.info(
			`Network card automatic - discovering on all ${available.length} card(s): ${availableLabels || 'none'}. ` +
				`Set 'Network card' in the connection config to restrict this to one subnet.`,
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

	arcSocket.on('message', (reply, rinfo) => {
		parseReply(self, reply, rinfo)
		parseAvReply(self, reply, rinfo)
	})
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

	// The settings path is two sockets when a card is chosen (see the binds below) and one otherwise;
	// either way it is only usable once both halves are up. Locals rather than connection state: the
	// handlers that read and write them are all created in this call and die with it.
	let settingsUnicastUp = false
	let settingsMulticastUp = false
	const updateSettingsStatus = () => {
		self.activeConnections.SETTINGS = settingsUnicastUp && settingsMulticastUp
		checkConnections(self)
	}

	// create Dante settings socket
	self.sockets.SETTINGS = dgram.createSocket({ type: 'udp4', reuseAddr: true, ...REUSE_PORT_OPTION })
	const settingSocket = self.sockets.SETTINGS
	settingSocket.on('message', (reply, rinfo) => parseSettingsReply(self, reply, rinfo))

	settingSocket.on('error', (error) => {
		logger.error(`Settings socket : ${error.message}`)
		settingsUnicastUp = false
		self.activeConnections.SETTINGS = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	settingSocket.on('close', () => {
		logger.warn('Settings socket closed')
		settingsUnicastUp = false
		self.activeConnections.SETTINGS = false
		if (self.CONNECTED) {
			self.updateStatus(InstanceStatus.Disconnected)
			self.CONNECTED = false
		}
	})

	settingSocket.on('listening', () => {
		settingsUnicastUp = true
		if (boundAddress === undefined) {
			// One socket doing both jobs, so it carries the group membership too. Without it the
			// socket is bound but deaf to announcements, so don't report the path as usable.
			settingsMulticastUp = joinMulticastGroup(
				settingSocket,
				DANTE_CONST.MULTICAST_IP.INFO,
				'SETTINGS',
				multicastInterfaces,
			)
		}
		updateSettingsStatus()
	})

	// Settings is the one service that both listens on a fixed port and sends unicast queries whose
	// replies come back to that same port. Those two jobs want incompatible binds, and with more than
	// one instance of this module on a host they conflict outright:
	//
	// - Multicast announcements only arrive on a wildcard-bound socket. A socket bound to a specific
	//   unicast address never sees them, since the packet's destination is the group address, not the
	//   bound one. Multicast is delivered to every socket bound to the port, so instances coexist.
	// - Unicast replies are the opposite. Two instances both bound to `0.0.0.0:8702` are equally
	//   specific, so the OS picks exactly one of them per datagram (a SO_REUSEPORT group load-balances
	//   unicast; multicast is exempt). One instance's settings reply is then delivered to the other,
	//   which drops it as an unregistered device - and the instance that asked never sees it. The
	//   choice is hashed per source, so it fails consistently for a given device rather than at random:
	//   sample rate, encoding, pullup, output level and the model variables silently stay empty.
	//
	// So when a card is chosen, split the jobs. This socket binds the card's own address, which
	// outscores any wildcard bind in the OS's socket lookup and so deterministically receives the
	// replies to its own queries; the listener below takes the multicast half. With the card automatic
	// there is only ever one instance's worth of scope to begin with, so one wildcard socket does both.
	if (boundAddress === undefined) {
		settingSocket.bind(DANTE_CONST.PORTS.INFO)
	} else {
		settingSocket.bind(DANTE_CONST.PORTS.INFO, boundAddress)

		// The multicast half of the settings path: receive-only, and never sent from - `sendCommand`
		// uses `sockets.SETTINGS` above. Kept out of `DanteSockets` because `ServiceName` also keys
		// the per-device port map, where a receive-only listener has no meaning.
		const settingsMulticastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true, ...REUSE_PORT_OPTION })
		self.connection.settingsMulticast = settingsMulticastSocket
		settingsMulticastSocket.on('message', (reply, rinfo) => parseSettingsReply(self, reply, rinfo))

		settingsMulticastSocket.on('error', (error) => {
			logger.error(`Settings multicast socket : ${error.message}`)
			settingsMulticastUp = false
			self.activeConnections.SETTINGS = false
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected)
				self.CONNECTED = false
			}
		})

		settingsMulticastSocket.on('close', () => {
			logger.warn('Settings multicast socket closed')
			settingsMulticastUp = false
			self.activeConnections.SETTINGS = false
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected)
				self.CONNECTED = false
			}
		})

		settingsMulticastSocket.on('listening', () => {
			settingsMulticastUp = joinMulticastGroup(
				settingsMulticastSocket,
				DANTE_CONST.MULTICAST_IP.INFO,
				'SETTINGS',
				multicastInterfaces,
			)
			updateSettingsStatus()
		})

		// Wildcard, for the reason given above - a specific bind would never see the group's traffic.
		// It therefore also receives announcements that arrived on cards the operator did not choose;
		// those are dropped by `parseSettingsReply`, which ignores devices discovery never registered.
		settingsMulticastSocket.bind(DANTE_CONST.PORTS.INFO)
	}

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
		// explicitly, while still scoping outgoing queries and group membership to the chosen card.
		// Incoming is therefore not scoped - `danteDiscovery` filters by subnet instead.
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

/**
 * (Re)starts the periodic mDNS device-discovery poll, per `config.interval`. Stops any existing
 * interval first; does nothing further if `config.interval` is 0.
 */
export function setupInterval(self: DanteInstance): void {
	self.connection.startInterval()
}

/** Stops the periodic mDNS device-discovery poll, if running. */
export function stopInterval(self: DanteInstance): void {
	self.connection.stopInterval()
}
