import { describe, expect, it, vi } from 'vitest'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import type { DevicesData } from './api.js'
import type DanteInstance from './main.js'

/**
 * Companion requires that any option referenced from another option's `isVisibleExpression` has
 * `disableAutoExpression: true`, otherwise the referencing expression cannot read its value.
 *
 * These tests walk the definitions this module actually generates rather than its source text, so
 * they cover the per-device option fields that are built dynamically from `devicesData`.
 */

/** Two devices with channels, so the per-device dynamic option fields are generated. */
function devicesData(): DevicesData {
	const channels = (count: number, prefix: string) => {
		const io: Record<string | number, unknown> = { count }
		for (let i = 1; i <= count; i++) io[i] = { number: i, name: `${prefix} ${i}` }
		return io
	}
	return {
		'10.0.0.5': { name: 'DeviceA', ports: { ARC: 4440 }, rx: channels(4, 'In'), tx: channels(4, 'Out') },
		'10.0.0.6': { name: 'DeviceB', ports: { ARC: 4440 }, rx: channels(2, 'In'), tx: channels(2, 'Out') },
	} as unknown as DevicesData
}

function mockInstance() {
	const data = devicesData()
	return {
		devicesData: data,
		devicesChoices: Object.entries(data).map(([ip, device]) => ({ id: ip, label: device.name! })),
		rxChannelsChoices: { DeviceA: [{ id: 1, label: 'In 1' }], DeviceB: [{ id: 1, label: 'In 1' }] },
		txChannelsChoices: { DeviceA: [{ id: 1, label: 'Out 1' }], DeviceB: [{ id: 1, label: 'Out 1' }] },
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

interface OptionLike {
	id: string
	type?: string
	choices?: { id: string | number; label: string }[]
	default?: unknown
	isVisibleExpression?: string
	disableAutoExpression?: boolean
}

interface DefinitionLike {
	options?: OptionLike[]
}

/** Every option id an `isVisibleExpression` in this definition reads. */
function referencedOptionIds(options: OptionLike[]): Set<string> {
	const referenced = new Set<string>()
	for (const option of options) {
		if (!option.isVisibleExpression) continue
		for (const match of option.isVisibleExpression.matchAll(/\$\(options:([A-Za-z0-9_]+)\)/g)) {
			referenced.add(match[1])
		}
	}
	return referenced
}

/** Returns `definitionId -> optionId` pairs which break the rule. */
function violations(definitions: Record<string, DefinitionLike>): string[] {
	const bad: string[] = []
	for (const [definitionId, definition] of Object.entries(definitions)) {
		const options = definition.options ?? []
		const byId = new Map(options.map((option) => [option.id, option]))

		for (const referencedId of referencedOptionIds(options)) {
			const target = byId.get(referencedId)
			if (!target) {
				bad.push(`${definitionId}.${referencedId} (referenced but not declared)`)
			} else if (target.disableAutoExpression !== true) {
				bad.push(`${definitionId}.${referencedId} (missing disableAutoExpression)`)
			}
		}
	}
	return bad
}

describe('isVisibleExpression dependencies', () => {
	it('every option an action visibility expression reads has disableAutoExpression', () => {
		const self = mockInstance()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		expect(violations(definitions)).toEqual([])
	})

	it('every option a feedback visibility expression reads has disableAutoExpression', () => {
		const self = mockInstance()
		UpdateFeedbacks(self)
		const definitions = (self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		expect(violations(definitions)).toEqual([])
	})

	it('actually inspects visibility expressions, rather than passing because it found none', () => {
		const self = mockInstance()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		const withExpressions = Object.values(definitions as Record<string, DefinitionLike>).filter(
			(definition) => referencedOptionIds(definition.options ?? []).size > 0,
		)
		expect(withExpressions.length).toBeGreaterThan(5)
	})

	it('flags a definition that breaks the rule', () => {
		expect(
			violations({
				bad: {
					options: [{ id: 'toggle' }, { id: 'shown', isVisibleExpression: '!$(options:toggle)' }],
				},
			}),
		).toEqual(['bad.toggle (missing disableAutoExpression)'])
	})
})

/** Returns `definitionId.optionId` for every dropdown whose default is not one of its own choices. */
function defaultsNotInChoices(definitions: Record<string, DefinitionLike>): string[] {
	const bad: string[] = []
	for (const [definitionId, definition] of Object.entries(definitions)) {
		for (const option of definition.options ?? []) {
			if (option.type !== 'dropdown' || !option.choices) continue
			// A dropdown with nothing to offer has no valid default to pick.
			if (option.choices.length === 0) continue

			if (!option.choices.some((choice) => choice.id === option.default)) {
				bad.push(`${definitionId}.${option.id} (default ${JSON.stringify(option.default)} not in choices)`)
			}
		}
	}
	return bad
}

describe('dropdown defaults', () => {
	it('every action dropdown defaults to one of its own choices', () => {
		const self = mockInstance()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		expect(defaultsNotInChoices(definitions)).toEqual([])
	})

	it('every feedback dropdown defaults to one of its own choices', () => {
		const self = mockInstance()
		UpdateFeedbacks(self)
		const definitions = (self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		expect(defaultsNotInChoices(definitions)).toEqual([])
	})

	it('holds when a filter excludes the first device overall', () => {
		// DeviceA has no tx channels, so any tx-filtered dropdown must not default to it
		const self = mockInstance()
		;(self.devicesData['10.0.0.5'] as { tx?: unknown }).tx = undefined
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		expect(defaultsNotInChoices(definitions)).toEqual([])
	})

	it('actually inspects dropdowns, rather than passing because it found none', () => {
		const self = mockInstance()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		const dropdowns = Object.values(definitions as Record<string, DefinitionLike>).flatMap((definition) =>
			(definition.options ?? []).filter((option) => option.type === 'dropdown' && option.choices?.length),
		)
		expect(dropdowns.length).toBeGreaterThan(10)
	})

	it('flags a dropdown whose default was filtered out', () => {
		expect(
			defaultsNotInChoices({
				bad: {
					options: [{ id: 'device', type: 'dropdown', choices: [{ id: 'b', label: 'B' }], default: 'a' }],
				},
			}),
		).toEqual(['bad.device (default "a" not in choices)'])
	})
})
