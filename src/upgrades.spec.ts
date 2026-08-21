import { describe, expect, it } from 'vitest'
import type {
	CompanionMigrationAction,
	CompanionStaticUpgradeProps,
	CompanionUpgradeContext,
} from '@companion-module/base'
import { UpgradeScripts } from './upgrades.js'
import type { ModuleConfig } from './config.js'

/**
 * The script added when the clear-crosspoint actions gained their `clearAll` checkbox.
 *
 * Pinned by index rather than taken as the last entry, so appending a future upgrade script does
 * not silently point this suite at the wrong one. Upgrade scripts are order-sensitive and must
 * never be reordered or removed, only appended.
 */
const CLEAR_ALL_SCRIPT_INDEX = 2
const addClearAllOption = UpgradeScripts[CLEAR_ALL_SCRIPT_INDEX]

function action(actionId: string, options: Record<string, unknown> = {}): CompanionMigrationAction {
	return {
		id: `action-${actionId}`,
		controlId: 'bank-1',
		actionId,
		options: options as CompanionMigrationAction['options'],
	}
}

function run(actions: CompanionMigrationAction[]) {
	return addClearAllOption(
		{} as CompanionUpgradeContext<ModuleConfig>,
		{ config: null, actions, feedbacks: [] } as unknown as CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	)
}

describe('clearAll upgrade script', () => {
	it('sits at the index this suite targets', () => {
		// If this fails, a script was inserted or removed rather than appended - fix the ordering,
		// do not just bump the index, or existing user configs will migrate through the wrong steps.
		expect(UpgradeScripts).toHaveLength(CLEAR_ALL_SCRIPT_INDEX + 1)
	})

	it('adds clearAll: false to a clearCrosspoint action saved before the option existed', () => {
		const existing = action('clearCrosspoint', { destinationChannelNumber: '1' })
		const result = run([existing])

		expect(result.updatedActions).toEqual([existing])
		expect(existing.options.clearAll).toEqual({ value: false, isExpression: false })
	})

	it('adds clearAll: false to the drop-down variant too', () => {
		const existing = action('clearCrosspointDropDown', { destinationDevice: '10.0.0.5' })
		run([existing])
		expect(existing.options.clearAll).toEqual({ value: false, isExpression: false })
	})

	it('leaves the action otherwise untouched', () => {
		const existing = action('clearCrosspoint', { destinationChannelNumber: '3', destinationDeviceAdddress: 'Amp' })
		run([existing])
		expect(existing.options.destinationChannelNumber).toBe('3')
		expect(existing.options.destinationDeviceAdddress).toBe('Amp')
	})

	it('does not touch an action that already has the option set', () => {
		const alreadySet = action('clearCrosspoint', { clearAll: { value: true, isExpression: false } })
		const result = run([alreadySet])

		expect(result.updatedActions).toEqual([])
		expect(alreadySet.options.clearAll).toEqual({ value: true, isExpression: false })
	})

	it('does not overwrite an explicit false', () => {
		const alreadyFalse = action('clearCrosspoint', { clearAll: { value: false, isExpression: false } })
		expect(run([alreadyFalse]).updatedActions).toEqual([])
	})

	it('ignores actions of other types', () => {
		const other = action('makeCrosspoint', { sourceDevice: '10.0.0.5' })
		const result = run([other])

		expect(result.updatedActions).toEqual([])
		expect(other.options.clearAll).toBeUndefined()
	})

	it('reports only the actions it changed', () => {
		const stale = action('clearCrosspoint')
		const current = action('clearCrosspointDropDown', { clearAll: { value: false, isExpression: false } })
		const unrelated = action('setDeviceName')

		expect(run([stale, current, unrelated]).updatedActions).toEqual([stale])
	})

	it('does not touch config or feedbacks', () => {
		const result = run([action('clearCrosspoint')])
		expect(result.updatedConfig).toBeNull()
		expect(result.updatedFeedbacks).toEqual([])
	})

	it('is a no-op when there are no actions', () => {
		expect(run([]).updatedActions).toEqual([])
	})
})
