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

	it('converts a numeric setOutputLevel level to the string id the dropdown offers', () => {
		const existing = action('setOutputLevel', { level: { value: 2, isExpression: false } })
		const result = run([existing])

		expect(result.updatedActions).toEqual([existing])
		expect(existing.options.level).toEqual({ value: '2', isExpression: false })
	})

	it('leaves a level already stored as a string alone', () => {
		const current = action('setOutputLevel', { level: { value: '2', isExpression: false } })
		expect(run([current]).updatedActions).toEqual([])
		expect(current.options.level).toEqual({ value: '2', isExpression: false })
	})

	it('leaves a level set to an expression alone', () => {
		const expression = action('setOutputLevel', { level: { value: '$(internal:foo)', isExpression: true } })
		expect(run([expression]).updatedActions).toEqual([])
		expect(expression.options.level).toEqual({ value: '$(internal:foo)', isExpression: true })
	})

	it('leaves a setOutputLevel action with no stored level alone', () => {
		const bare = action('setOutputLevel', {})
		expect(run([bare]).updatedActions).toEqual([])
		expect(bare.options.level).toBeUndefined()
	})

	it('migrates both concerns in one pass, reporting the action once', () => {
		const clear = action('clearCrosspoint')
		const level = action('setOutputLevel', { level: { value: 5, isExpression: false } })
		const result = run([clear, level])

		expect(result.updatedActions).toEqual([clear, level])
		expect(clear.options.clearAll).toEqual({ value: false, isExpression: false })
		expect(level.options.level).toEqual({ value: '5', isExpression: false })
	})

	it('does not add clearAll to a setOutputLevel action', () => {
		const level = action('setOutputLevel', { level: { value: 2, isExpression: false } })
		run([level])
		expect(level.options.clearAll).toBeUndefined()
	})

	it('converts a numeric per-device sample rate to its string choice id', () => {
		const existing = action('setSampleRate', {
			device: { value: '10.0.0.5', isExpression: false },
			'sr_10.0.0.5': { value: 48000, isExpression: false },
		})
		run([existing])
		expect(existing.options['sr_10.0.0.5']).toEqual({ value: '48000', isExpression: false })
		// the device picker is not a numeric option and must be left alone
		expect(existing.options.device).toEqual({ value: '10.0.0.5', isExpression: false })
	})

	it('converts numeric pullup and encoding values too', () => {
		const pullup = action('setPullup', { 'pullup_10.0.0.5': { value: 2, isExpression: false } })
		const encoding = action('setEncoding', { 'encoding_10.0.0.5': { value: 24, isExpression: false } })
		run([pullup, encoding])
		expect(pullup.options['pullup_10.0.0.5']).toEqual({ value: '2', isExpression: false })
		expect(encoding.options['encoding_10.0.0.5']).toEqual({ value: '24', isExpression: false })
	})

	it('migrates every per-device key on an action that has several', () => {
		// an action saved while more than one device was on the network carries one key per device
		const existing = action('setSampleRate', {
			'sr_10.0.0.5': { value: 48000, isExpression: false },
			'sr_10.0.0.6': { value: 96000, isExpression: false },
		})
		run([existing])
		expect(existing.options['sr_10.0.0.5']).toEqual({ value: '48000', isExpression: false })
		expect(existing.options['sr_10.0.0.6']).toEqual({ value: '96000', isExpression: false })
	})

	it('leaves per-device values already stored as strings alone', () => {
		const current = action('setSampleRate', { 'sr_10.0.0.5': { value: '48000', isExpression: false } })
		expect(run([current]).updatedActions).toEqual([])
	})

	it('does not migrate per-device keys on an unrelated action', () => {
		const other = action('setLatency', { 'sr_10.0.0.5': { value: 48000, isExpression: false } })
		expect(run([other]).updatedActions).toEqual([])
		expect(other.options['sr_10.0.0.5']).toEqual({ value: 48000, isExpression: false })
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
