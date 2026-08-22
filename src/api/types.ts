/**
 * Shared shapes for the Dante protocol and the device registry.
 */
import type dgram from 'node:dgram'

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

/** What an rx channel is currently subscribed to, as the device reports it. */
export interface RxChannelSource {
	/** Name of the transmitting device, with the '.' self-route shorthand already resolved. */
	deviceName: string
	/** Name of the transmitting channel. */
	channelName: string
	/**
	 * True when the subscription is actually carrying audio.
	 *
	 * A subscription can exist and not be working - the source device offline, or the channel it
	 * names no longer present - in which case the device reports a status that is not one of the
	 * connected ones.
	 */
	connected: boolean
}
