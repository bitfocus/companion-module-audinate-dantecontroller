/**
 * Publishing variables to Companion without redundant traffic.
 */

import type { CompanionVariableDefinitions, CompanionVariableValue } from '@companion-module/base'
import type DanteInstance from './main.js'
import type { DanteVariableValues } from './types.js'

type Definitions = CompanionVariableDefinitions<DanteVariableValues>
type Values = Partial<DanteVariableValues>

/**
 * Mirrors what the Companion host already holds, so only real changes are sent.
 *
 * The host forwards every value it is given and re-sends the whole definition list on every
 * `setVariableDefinitions`, with no comparison of its own. With per-channel routing variables a
 * network holds thousands of them, so pushing a device's full set on every reply would be most of
 * the module's traffic. This keeps the last published definitions and values and sends only what
 * differs.
 *
 * The value cache follows the host's own rules for a definition change: a newly defined variable
 * starts as `''`, a removed one is deleted, and every other value is kept.
 */
export class VariablePublisher {
	#definitionsKey: string | undefined
	#definedIds = new Set<string>()
	readonly #values = new Map<string, CompanionVariableValue | undefined>()

	constructor(private readonly self: Pick<DanteInstance, 'setVariableDefinitions' | 'setVariableValues'>) {}

	/** Publishes definitions, unless they match the last ones sent. Returns whether anything was sent. */
	setDefinitions(definitions: Definitions): boolean {
		const entries = Object.entries(definitions as Record<string, { name: string } | undefined>)
			.filter((entry): entry is [string, { name: string }] => entry[1] !== undefined)
			.map(([id, definition]) => [id, definition.name] as const)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		const key = JSON.stringify(entries)
		if (key === this.#definitionsKey) return false

		this.self.setVariableDefinitions(definitions)
		this.#definitionsKey = key

		const ids = new Set(entries.map(([id]) => id))
		for (const id of this.#definedIds) {
			if (!ids.has(id)) this.#values.delete(id)
		}
		for (const id of ids) {
			if (!this.#definedIds.has(id)) this.#values.set(id, '')
		}
		this.#definedIds = ids
		return true
	}

	/**
	 * Publishes the values that differ from what was last sent, in one batch. Values for variables
	 * that are not defined are dropped: the host would only reject them. Returns how many were sent.
	 */
	setValues(values: Values): number {
		const changed: Record<string, CompanionVariableValue | undefined> = {}
		let count = 0
		for (const [id, value] of Object.entries(values)) {
			if (!this.#definedIds.has(id)) continue
			if (sameValue(this.#values.get(id), value)) continue
			changed[id] = value
			count++
		}
		if (count === 0) return 0

		this.self.setVariableValues(changed as Values)
		for (const [id, value] of Object.entries(changed)) {
			this.#values.set(id, value)
		}
		return count
	}

	/** Forgets everything sent, for when the host's state is being replaced wholesale. */
	reset(): void {
		this.#definitionsKey = undefined
		this.#definedIds = new Set()
		this.#values.clear()
	}
}

/** Values are scalars or small arrays (channel names, output levels), so arrays compare by content. */
function sameValue(a: CompanionVariableValue | undefined, b: CompanionVariableValue | undefined): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
	}
	return false
}
