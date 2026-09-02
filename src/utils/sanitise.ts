/**
 * Making runtime-derived names safe to use as Companion identifiers.
 */

/**
 * Strips everything Companion does not accept in a variable or option id.
 *
 * Both kinds of id are built from device names here, and a Dante device may be named anything its
 * owner likes - spaces, brackets and parentheses are all common in the field. An id containing them
 * is not merely ugly: Companion cannot parse `$(dante:My Device_ip)` as a variable reference, and an
 * option id with a space misbehaves in the option store, so the field it names stops working.
 *
 * `.`, `-` and `_` are kept, which leaves an IPv4 address untouched - per-device option ids saved
 * before devices were keyed by name are suffixed with an address, and those must still resolve.
 *
 * @param substitute What each rejected character becomes. Defaults to `_`, so distinct names stay
 * distinct in the common case; pass `''` to drop them instead.
 */
export const sanitiseVariableId = (id: string, substitute: '' | '.' | '-' | '_' = '_'): string =>
	id.replaceAll(/[^a-zA-Z0-9-_.]/gm, substitute)
