import {
	FixupNumericOrVariablesValueToExpressions,
	type CompanionMigrationAction,
	type CompanionStaticUpgradeScript,
	type CompanionStaticUpgradeResult,
	type CompanionUpgradeContext,
	type CompanionStaticUpgradeProps,
} from '@companion-module/base'
import { TIMEOUT_MAXIMUM, TIMEOUT_MINIMUM, UPDATE_MAXIMUM, UPDATE_MINIMUM, type ModuleConfig } from './config.js'

/**
 * Maps an action id to the list of its option ids which used to be a numeric textinput
 * (with `useVariables: true`) and are now a `number` field.
 */
const numericOptionsByActionId: Record<string, string[]> = {
	setLatency: ['latency'],
	setSampleRateCustom: ['sr'],
}

/** The config shape before the network card setting was renamed from `ip` to `mac`. */
type LegacyIpConfig = Omit<ModuleConfig, 'mac'> & { ip?: string; mac?: string }

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
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		// The network card setting was renamed from `ip` to `mac`, because a card is now identified by
		// its hardware address rather than by an IPv4 address that changes with DHCP or link-local
		// assignment. Only the key is renamed here: the stored value may still be a bare address, and
		// resolving that to a hardware address needs the address to still be assigned - so that part
		// happens on the next successful connect, in initConnection.
		const config: LegacyIpConfig | null = props.config
		if (!config || config.ip === undefined) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}

		const { ip, ...rest } = config
		return {
			updatedConfig: { ...rest, mac: rest.mac ?? ip },
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		// Variables became optional. Existing connections were created when they were unconditional,
		// so default them to on: turning it off is a deliberate choice, never something an upgrade
		// should decide on a user's behalf.
		const config = props.config
		if (!config || config.variables !== undefined) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}

		return {
			updatedConfig: { ...config, variables: true },
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		// The interval fields gained bounds. Values saved before that could be anything the number field
		// allowed: 0, which used to mean "off" and now just means "far too fast", or an hour, which
		// left an unplugged device looking healthy for two. Pull anything outside the range back into
		// it; leave everything already inside alone.
		const config = props.config
		if (!config) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}

		const clamp = (value: number | undefined, low: number, high: number) => Math.min(Math.max(value ?? low, low), high)
		const interval = clamp(config.interval, UPDATE_MINIMUM, UPDATE_MAXIMUM)
		const timeoutInterval = clamp(config.timeoutInterval, TIMEOUT_MINIMUM, TIMEOUT_MAXIMUM)
		if (interval === config.interval && timeoutInterval === config.timeoutInterval) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}

		return {
			updatedConfig: { ...config, interval, timeoutInterval },
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
]
