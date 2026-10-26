import { describe, expect, it, vi } from 'vitest'
import { UpdateFeedbacks } from '../feedbacks.js'
import type { DevicesData } from '../api/index.js'
import type DanteInstance from '../main.js'

/**
 * A route the destination still reports must read as connected, even when the source device is not
 * currently reporting.
 *
 * The destination is the authority on its own subscriptions: it names the source device and channel
 * it is subscribed to. Both halves of that comparison used to be resolved from the *source* device's
 * live record, so a source that had gone quiet - or whose one-shot directory reply was dropped -
 * made a perfectly good route read false. The picker already holds the device name, and the retained
 * choice lists still hold the channel's, so neither needs the source to be reporting.
 *
 * The rule this must not break: if the destination reports no source, or a different one, or (for
 * audio) a subscription in error, the answer is false. Nothing remembered may stand in for the
 * destination's own account of the route.
 */

const D_IP = '172.16.3.143'
const D = 'DAV-02HR-Stage1'
const S_IP = '172.16.3.141'
const S = 'DAV-02HT-100323'
const CH = 'SmartPi'

interface Channel {
	number: number
	name: string
	sourceDevice?: string
	sourceChannel?: string
	/** audio */
	subscriptionStatus?: number
	/** video - 1 when media is actually flowing */
	subscriptionActive?: number
	subscriptionResolved?: number
}

/** CONNECTED_UNICAST / a resolution failure, per DANTE_CONST.SUBSCRIPTION_STATUS. */
const CONNECTED = 0x0009
const IN_ERROR = 0x0011

function instance(channel: Channel, { sourceOnline, audio = false }: { sourceOnline: boolean; audio?: boolean }) {
	const devicesData: Record<string, unknown> = {
		[D_IP]: {
			name: D,
			ports: { ARC: 4440 },
			...(audio ? { audioRx: { count: 1, 1: channel } } : { videoRx: { count: 1, 1: channel } }),
		},
	}
	if (sourceOnline) {
		devicesData[S_IP] = {
			name: S,
			ports: { ARC: 4440 },
			videoTx: { count: 1, 1: { number: 1, name: CH } },
			audioTx: { count: 1, 1: { number: 1, name: CH } },
		}
	}

	let definitions: Record<string, { callback: (feedback: unknown, ctx: unknown) => unknown }> = {}
	const self = {
		devicesData: devicesData as unknown as DevicesData,
		devicesChoices: [{ id: D, label: D }, ...(sourceOnline ? [{ id: S, label: S }] : [])],
		// retained across the source going quiet, by destroyDevice
		rxChannelsChoices: { [D]: [{ id: 1, label: 'In 1' }] },
		txChannelsChoices: { [S]: [{ id: 1, label: CH }] },
		videoRxChannelsChoices: { [D]: [{ id: 1, label: 'Rear' }] },
		videoTxChannelsChoices: { [S]: [{ id: 1, label: CH }] },
		config: { variables: true },
		setFeedbackDefinitions: (d: typeof definitions) => (definitions = d),
		setActionDefinitions: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance

	UpdateFeedbacks(self)
	return { self, definitions }
}

function crosspointConnected(channel: Channel, opts: { sourceOnline: boolean; audio?: boolean }): boolean {
	const { definitions } = instance(channel, opts)
	const suffix = opts.audio ? '' : 'Video'
	return definitions.routing_bg.callback(
		{
			id: 'fb',
			options: {
				channelType: opts.audio ? 'audio' : 'video',
				destinationDevice: D,
				[`destinationChannel${suffix}_${D}`]: 1,
				sourceDevice: S,
				[`sourceChannel${suffix}_${S}`]: 1,
			},
		},
		{},
	) as boolean
}

/** A route that is both named by the destination and actually carrying media. */
const routed: Channel = {
	number: 1,
	name: 'Rear',
	sourceDevice: S,
	sourceChannel: CH,
	subscriptionResolved: 1,
	subscriptionActive: 1,
}

describe('Crosspoint - Connected with the source device offline', () => {
	it('is true for video when the destination still reports the route', () => {
		expect(crosspointConnected(routed, { sourceOnline: false })).toBe(true)
	})

	it('is true for video when the source is online, as it always was', () => {
		expect(crosspointConnected(routed, { sourceOnline: true })).toBe(true)
	})

	it('is false when the destination reports no source at all', () => {
		expect(crosspointConnected({ number: 1, name: 'Rear' }, { sourceOnline: false })).toBe(false)
	})

	it('is false when the destination names a different source device', () => {
		const elsewhere = { ...routed, sourceDevice: 'Other-Box' }
		expect(crosspointConnected(elsewhere, { sourceOnline: false })).toBe(false)
	})

	it('is false for video when the destination says the subscription is not active', () => {
		// the source device being offline is not what decides this - the destination reporting that
		// nothing is flowing is. Dante Controller calls this state "Subscription is not active".
		const idle = { ...routed, subscriptionActive: 0 }
		expect(crosspointConnected(idle, { sourceOnline: false })).toBe(false)
		expect(crosspointConnected(idle, { sourceOnline: true })).toBe(false)
	})

	it('is false when the destination names a different source channel', () => {
		const elsewhere = { ...routed, sourceChannel: 'SomeOtherChannel' }
		expect(crosspointConnected(elsewhere, { sourceOnline: false })).toBe(false)
	})

	it('is true for audio when the subscription is healthy', () => {
		const audioRouted = { ...routed, name: 'In 1', subscriptionStatus: CONNECTED }
		expect(crosspointConnected(audioRouted, { sourceOnline: false, audio: true })).toBe(true)
	})

	it('is false for audio when the destination reports the subscription in error', () => {
		// the names match perfectly - the destination's own account of the route is what decides
		const broken = { ...routed, name: 'In 1', subscriptionStatus: IN_ERROR }
		expect(crosspointConnected(broken, { sourceOnline: false, audio: true })).toBe(false)
	})
})

describe('Channel - Subscription with the source device offline', () => {
	function subscription(opts: { sourceOnline: boolean }) {
		const { definitions } = instance(routed, opts)
		return definitions.channel_subscription.callback(
			{ id: 'fb', options: { channelType: 'video', device: D, [`channelVideo_${D}`]: 1 } },
			{},
		) as { connected: boolean; device: { name: string }; channel: { name: string; number: number } }
	}

	it('still reports the source device and channel the destination named', () => {
		const result = subscription({ sourceOnline: false })
		expect(result.connected).toBe(true)
		expect(result.device.name).toBe(S)
		expect(result.device.name).toBe(S)
		expect(result.channel.name).toBe(CH)
	})

	it('recovers the channel number from the retained choices rather than reporting 0', () => {
		expect(subscription({ sourceOnline: false }).channel.number).toBe(1)
		expect(subscription({ sourceOnline: true }).channel.number).toBe(1)
	})
})
