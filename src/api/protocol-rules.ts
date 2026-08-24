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

/** True if `status` (rx record offset 14) indicates a live subscription. */
export function isSubscriptionConnected(status: number | undefined): boolean {
	return status !== undefined && SUBSCRIPTION_STATUS_CONNECTED.includes(status)
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
