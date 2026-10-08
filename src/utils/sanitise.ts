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

/**
 * Names that collide once sanitised, grouped by the id they all become.
 *
 * Sanitising is lossy: `Rack 1` and `Rack-1` are different devices but the same id. Everything keyed
 * by that id then belongs to whichever device was seen last - its variables overwrite the other's,
 * and a per-device option field appears twice in one action with no way to tell the two apart. Rare,
 * but silent, and impossible to diagnose from the symptoms.
 *
 * Only ids that more than one *distinct* name maps to are returned; one name reaching this twice
 * (two addresses announcing it, say) is not a collision.
 */
export function collidingIds(names: Iterable<string>): Map<string, string[]> {
	const byId = new Map<string, string[]>()
	for (const name of names) {
		const id = sanitiseVariableId(name)
		const group = byId.get(id)
		if (!group) byId.set(id, [name])
		else if (!group.includes(name)) group.push(name)
	}

	for (const [id, group] of byId) {
		if (group.length < 2) byId.delete(id)
	}
	return byId
}
