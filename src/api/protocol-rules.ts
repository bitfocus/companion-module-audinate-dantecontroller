/**
 * Rules over the protocol constants.
 *
 * Higher level than `protocol.ts`, which packs and parses bytes: these answer questions about
 * what the protocol permits and what a reported value means.
 */

import { DANTE_CONST } from './const.js'

/**
 * The label for a code a device reported, or undefined when it is not one this module knows.
 *
 * The code maps are keyed by literal unions so their choice ids are precise, which means a raw
 * number off the wire cannot index them directly - a device is free to report a code we have no
 * label for.
 */
export function codeLabel<Key extends string | number>(map: Record<Key, string>, code: number): string | undefined {
	return Object.prototype.hasOwnProperty.call(map, code) ? map[code as Key] : undefined
}

/**
 * Subscription status codes that mean audio is actually reaching the receive channel.
 *
 * See {@link DANTE_CONST.SUBSCRIPTION_STATUS} for how these were established.
 */
export const SUBSCRIPTION_STATUS_CONNECTED: readonly number[] = [
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_SELF,
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_UNICAST,
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_MULTICAST,
	DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_UNVERIFIED,
]

/**
 * Readable names for rx subscription status codes, for error messages and the `_rx_<n>_status`
 * variables. From the netaudio project's catalogue; only the connected ones above, 0x0001
 * (unresolved) and 0x001c (seen for a refused self-route on an Ultimo X2) have been observed here.
 *
 * The connected codes are all plain `connected`: the code beside it says which kind.
 */
const SUBSCRIPTION_STATUS_NAMES: Readonly<Record<number, string>> = {
	0x0000: 'no subscription',
	0x0001: 'unresolved',
	[DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_SELF]: 'connected',
	[DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_UNICAST]: 'connected',
	[DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_MULTICAST]: 'connected',
	[DANTE_CONST.SUBSCRIPTION_STATUS.CONNECTED_UNVERIFIED]: 'connected',
	0x0002: 'resolved, connecting',
	0x0003: 'resolve failed',
	0x0005: 'resolved to nothing',
	0x0007: 'idle',
	0x0008: 'connecting',
	0x000f: 'no connection',
	0x0010: 'channel format mismatch',
	0x0011: 'bundle format mismatch',
	0x0012: 'no receive resources',
	0x0013: 'receive failure',
	0x0014: 'no transmit resources',
	0x0015: 'transmit failure',
	0x0016: 'receive QoS failure',
	0x0017: 'transmit QoS failure',
	0x0018: 'transmitter rejected the address',
	0x0019: 'invalid message',
	0x001a: 'latency too low',
	0x001b: 'different clock domain',
	0x001c: 'unsupported',
	0x001d: 'receive link down',
	0x001e: 'transmit link down',
	0x0020: 'invalid channel',
	0x0022: 'self-subscription not allowed',
	0x0025: 'transmitter flow limit reached',
	0x0026: 'transmit channel encrypted',
	0x0060: 'transmit access denied',
	0x0061: 'transmit access pending',
	0x00ff: 'system failure',
}

/** A subscription status as a message names it: `unresolved (0x0001)`. */
export function subscriptionStatusLabel(status: number | undefined): string {
	if (status === undefined) return 'unknown status'
	const code = `0x${status.toString(16).padStart(4, '0')}`
	return SUBSCRIPTION_STATUS_NAMES[status] ? `${SUBSCRIPTION_STATUS_NAMES[status]} (${code})` : code
}

/** True if `status` (rx record offset 14) indicates a live subscription. */
export function isSubscriptionConnected(status: number | undefined): boolean {
	return status !== undefined && SUBSCRIPTION_STATUS_CONNECTED.includes(status)
}

/**
 * Values of a video rx record's `subscriptionActive` byte that mean media is reaching the channel.
 *
 * Only 0 and 1 have ever been observed, so this could be a boolean test - it is a set to match the
 * audio rule above, because audio turned out to have four distinct connected codes and there is no
 * reason to assume video will not grow more. Adding one is then a line here rather than a rewrite.
 */
export const VIDEO_SUBSCRIPTION_ACTIVE: readonly number[] = [1]

/**
 * True if a video rx channel's `subscriptionActive` byte says media is actually flowing.
 *
 * This is the video counterpart of {@link isSubscriptionConnected}, and the distinction it draws is
 * the one Dante Controller draws: a subscription whose source is present but sending nothing reads
 * "Subscription is not active" there, and false here. A destination reporting a source is therefore
 * not on its own evidence of a working crosspoint.
 */
export function isVideoSubscriptionActive(active: number | undefined): boolean {
	return active !== undefined && VIDEO_SUBSCRIPTION_ACTIVE.includes(active)
}

/**
 * A video subscription's state in words, the counterpart of {@link subscriptionStatusLabel}.
 *
 * Video rx records carry two flags rather than a status code, so this names the combinations:
 * `active` when media is flowing; otherwise `unresolved` while the source has not been located,
 * and `not active` once it has (Dante Controller's "Subscription is not active"). `resolved` lags a
 * source going away, so an absent source can read `not active` for a while before `unresolved` -
 * the `active` test, which is the one that matters, does not lag. `unknown status` when the
 * device has not reported the flags at all.
 */
export function videoSubscriptionStatusLabel(resolved: number | undefined, active: number | undefined): string {
	if (active === undefined) return 'unknown status'
	if (isVideoSubscriptionActive(active)) return 'active'
	return resolved === 0 ? 'unresolved' : 'not active'
}

/** Longest name a Dante device accepts, for both device and channel names. */
export const DANTE_NAME_MAX_LENGTH = 31

/**
 * Checks a name against the rules Dante devices enforce, returning why it is invalid or
 * `undefined` if it is acceptable.
 *
 * Devices silently reject a malformed name, so without this a user just sees nothing happen.
 * Rules mirror the netaudio reference implementation: at most 31 characters, ASCII letters,
 * digits and hyphens only, and no leading or trailing hyphen. Channel names may additionally
 * contain a colon, which separates a channel from its device in subscription strings.
 *
 * `allowSpace` is for `AV_EXTENDED` video channel names specifically: real hardware ships with
 * (and accepted, live) names like "Decoder Video Channel" that this rule would otherwise reject -
 * video channel naming evidently allows spaces even though the netaudio-derived audio rule above
 * does not, and there is no equivalent reference for it to mirror instead.
 *
 * An empty name is accepted here because the module uses it to mean "reset to default".
 */
export function validateDanteName(
	name: string,
	options: { allowColon?: boolean; allowSpace?: boolean } = {},
): string | undefined {
	if (name === '') {
		return undefined
	}
	if (name.length > DANTE_NAME_MAX_LENGTH) {
		return `must be ${DANTE_NAME_MAX_LENGTH} characters or fewer (got ${name.length})`
	}

	const allowedChars = `A-Za-z0-9-${options.allowColon ? ':' : ''}${options.allowSpace ? ' ' : ''}`
	const allowed = new RegExp(`^[${allowedChars}]+$`)
	if (!allowed.test(name)) {
		// 'letters, digits and hyphens', optionally extended with 'colons'/'spaces' - built rather
		// than hardcoded per combination so the phrasing stays natural ('X, Y and Z') either way.
		const extras = [options.allowColon && 'colons', options.allowSpace && 'spaces'].filter(Boolean) as string[]
		const parts = ['letters', 'digits', ...(extras.length > 0 ? ['hyphens', ...extras] : ['hyphens'])]
		const last = parts.pop()
		return `may only contain ${parts.join(', ')} and ${last}`
	}

	const edges = options.allowColon ? ['-', ':'] : ['-']
	for (const edge of edges) {
		if (name.startsWith(edge) || name.endsWith(edge)) {
			return `may not start or end with '${edge}'`
		}
	}

	return undefined
}
