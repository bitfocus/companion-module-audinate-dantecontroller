import {
	FixupNumericOrVariablesValueToExpressions,
	type CompanionMigrationAction,
	type CompanionStaticUpgradeScript,
	type CompanionStaticUpgradeResult,
	type CompanionUpgradeContext,
	type CompanionStaticUpgradeProps,
} from '@companion-module/base'
import type { ModuleConfig } from './config.js'

/**
 * Maps an action id to the list of its option ids which used to be a numeric textinput
 * (with `useVariables: true`) and are now a `number` field.
 */
const numericOptionsByActionId: Record<string, string[]> = {
	setLatency: ['latency'],
	setSampleRateCustom: ['sr'],
}

/**
 * Option ids whose stored value must be a string to match their dropdown's choice ids.
 *
 * The per-device settings options are named after the device (`sr_10.0.0.5`), so they are matched
 * by prefix rather than listed.
 */
const NUMERIC_TO_STRING_PREFIXES = ['sr_', 'pullup_', 'encoding_']

function numericToStringOptionIds(action: CompanionMigrationAction): string[] {
	if (action.actionId === 'setOutputLevel') return ['level']
	if (action.actionId === 'setSampleRate' || action.actionId === 'setPullup' || action.actionId === 'setEncoding') {
		return Object.keys(action.options).filter((id) => NUMERIC_TO_STRING_PREFIXES.some((p) => id.startsWith(p)))
	}
	return []
}

/** Actions which gained the `clearAll` checkbox, and so need it present rather than undefined. */
const clearAllActionIds = ['clearCrosspoint', 'clearCrosspointDropDown']

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		_props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		// This is a placeholder than now cannot be used/removed
		return {
			updatedConfig: null,
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		// Fields which used to be a textinput with useVariables so users could enter a number or a variable
		// are now a number field which supports expressions. Convert previously stored values accordingly.
		const changedActions: CompanionMigrationAction[] = []
		for (const action of props.actions) {
			const optionKeys = numericOptionsByActionId[action.actionId]
			if (!optionKeys) continue

			let changed = false
			for (const optionKey of optionKeys) {
				const rawValue = action.options[optionKey]
				if (rawValue === undefined) continue

				action.options[optionKey] = FixupNumericOrVariablesValueToExpressions(rawValue)
				changed = true
			}

			if (changed) changedActions.push(action)
		}

		return {
			updatedConfig: null,
			updatedActions: changedActions,
			updatedFeedbacks: [],
		}
	},
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		// Options added or retyped in this release. Note that options are stored as ExpressionOrValue
		// wrappers rather than bare values, so migrated values have to be written in that shape.
		const changedActions: CompanionMigrationAction[] = []
		for (const action of props.actions) {
			let changed = false

			// The clear-crosspoint actions gained a `clearAll` checkbox. Actions saved before that have
			// no such option, which leaves the channel field's `!$(options:clearAll)` visibility
			// expression resolving against undefined - so give them the explicit `false` they predate.
			if (clearAllActionIds.includes(action.actionId) && action.options.clearAll === undefined) {
				action.options.clearAll = { value: false, isExpression: false }
				changed = true
			}

			// Several dropdowns carry string choice ids while their stored values could be numbers: the
			// Level list is built by object2choices (ids come from Object.entries, so always strings),
			// and the per-device sample rate, pullup and encoding lists likewise. A stored number
			// matches no choice, so the dropdown shows nothing and a learn cannot select anything.
			for (const optionId of numericToStringOptionIds(action)) {
				const stored = action.options[optionId]
				if (stored !== undefined && !stored.isExpression && typeof stored.value === 'number') {
					action.options[optionId] = { value: String(stored.value), isExpression: false }
					changed = true
				}
			}

			if (changed) changedActions.push(action)
		}

		return {
			updatedConfig: null,
			updatedActions: changedActions,
			updatedFeedbacks: [],
		}
	},
]
