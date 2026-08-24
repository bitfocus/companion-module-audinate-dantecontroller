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

export interface AudioTxChannel {
	number: number
	name?: string
	friendlyName?: string
	sampleRate?: number
}

export interface AudioRxChannel {
	number: number
	name?: string
	sourceChannel?: string
	sourceDevice?: string
	channelStatus?: number
	subscriptionStatus?: number
	sampleRate?: number
}

export type AudioTxChannels = Record<number, AudioTxChannel> & { count?: number }

export type AudioRxChannels = Record<number, AudioRxChannel> & { count?: number }

/**
 * A video channel, as reported by the `AV_EXTENDED` protocol's channel directory
 * (`MESSAGE_TYPE_AV_TX_CHANNEL_QUERY`). Separate from `AudioTxChannel`/`AudioRxChannel`: video
 * channels are a distinct address space from audio ones even though both start numbering from 1,
 * and the `AV_EXTENDED` directory does not report a sample rate or friendly name the way the
 * legacy protocol's channel queries do.
 */
export interface VideoTxChannel {
	number: number
	name?: string
}

/** A video receive channel, additionally carrying what it is currently subscribed to. */
export interface VideoRxChannel extends VideoTxChannel {
	sourceChannel?: string
	sourceDevice?: string
}

export type VideoTxChannels = Record<number, VideoTxChannel> & { count?: number }

export type VideoRxChannels = Record<number, VideoRxChannel> & { count?: number }

/**
 * The kinds of channel a crosspoint action/feedback can address, as one dropdown option shared by
 * all of them - see `channelOptionPrefix`/`mediaChannelChoices` in `choices.ts`. New entries here
 * (a future USB or serial-over-Dante channel type, say) only need a wire-level implementation and
 * an entry in `CHANNEL_MEDIA_TYPE_LABELS`; every action/feedback picks it up automatically since
 * their per-device option fields are generated once per entry in this list.
 */
export const CHANNEL_MEDIA_TYPES = ['audio', 'video'] as const

export type ChannelMediaType = (typeof CHANNEL_MEDIA_TYPES)[number]

/** Dropdown label for each {@link ChannelMediaType}. */
export const CHANNEL_MEDIA_TYPE_LABELS: Record<ChannelMediaType, string> = {
	audio: 'Audio',
	video: 'Video',
}

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
	audioTx?: AudioTxChannels
	audioRx?: AudioRxChannels
	videoTx?: VideoTxChannels
	videoRx?: VideoRxChannels
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
export interface AudioRxChannelSource {
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

/**
 * What a video rx channel is currently subscribed to, as the device reports it.
 *
 * No `connected` flag: unlike audio's `AudioRxChannel`, the `AV_EXTENDED` protocol has not been observed
 * to report a subscription that exists but is not carrying video - the source/device name pointers
 * are simply absent when there is no live source, so presence of this value already means connected.
 */
export interface VideoRxChannelSource {
	deviceName: string
	channelName: string
}
