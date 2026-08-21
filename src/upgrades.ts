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
		// The clear-crosspoint actions gained a `clearAll` checkbox. Actions saved before that have no
		// such option, which leaves the channel field's `!$(options:clearAll)` visibility expression
		// resolving against undefined - so give existing actions the explicit `false` they predate.
		const changedActions: CompanionMigrationAction[] = []
		for (const action of props.actions) {
			if (!clearAllActionIds.includes(action.actionId)) continue
			if (action.options.clearAll !== undefined) continue

			// Options are stored as ExpressionOrValue wrappers, not bare values
			action.options.clearAll = { value: false, isExpression: false }
			changedActions.push(action)
		}

		return {
			updatedConfig: null,
			updatedActions: changedActions,
			updatedFeedbacks: [],
		}
	},
]
