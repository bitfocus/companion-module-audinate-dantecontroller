import { describe, expect, it, vi } from 'vitest'
import type {
	CompanionMigrationAction,
	CompanionStaticUpgradeProps,
	CompanionUpgradeContext,
} from '@companion-module/base'
import { UpgradeScripts } from '../upgrades.js'
import { REFRESH_ALL, UpdateActions } from '../actions.js'
import type DanteInstance from '../main.js'
import { TIMEOUT_MAXIMUM, TIMEOUT_MINIMUM, UPDATE_MAXIMUM, UPDATE_MINIMUM } from '../config.js'
import type { ModuleConfig } from '../config.js'

/**
 * Upgrade scripts by index. They are order-sensitive: a stored `upgradeIndex` records how far a
 * configuration has been migrated, so scripts may only ever be appended - never inserted, reordered
 * or removed. Each suite pins the one it targets rather than taking the last entry, so appending a
 * new script cannot silently retarget an existing suite.
 */
const CLEAR_ALL_SCRIPT_INDEX = 2
const CONFIG_RENAME_SCRIPT_INDEX = 3
const VARIABLES_OPTION_SCRIPT_INDEX = 4
const INTERVAL_MINIMUMS_SCRIPT_INDEX = 5
const REFRESH_DEVICE_SCRIPT_INDEX = 6
const EXPECTED_SCRIPT_COUNT = 7

const addClearAllOption = UpgradeScripts[CLEAR_ALL_SCRIPT_INDEX]
const renameIpToMac = UpgradeScripts[CONFIG_RENAME_SCRIPT_INDEX]
const defaultVariablesOption = UpgradeScripts[VARIABLES_OPTION_SCRIPT_INDEX]
const applyIntervalMinimums = UpgradeScripts[INTERVAL_MINIMUMS_SCRIPT_INDEX]
const addRefreshDeviceOption = UpgradeScripts[REFRESH_DEVICE_SCRIPT_INDEX]

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
		// Appending a script is fine - bump EXPECTED_SCRIPT_COUNT. If an existing index now points at
		// a different script, one was inserted or removed rather than appended: fix the ordering
		// instead of moving the index, or existing configurations migrate through the wrong steps.
		expect(UpgradeScripts).toHaveLength(EXPECTED_SCRIPT_COUNT)
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

describe('ip to mac config rename', () => {
	function runConfig(config: Record<string, unknown> | null) {
		return renameIpToMac(
			{} as CompanionUpgradeContext<ModuleConfig>,
			{
				config,
				secrets: null,
				actions: [],
				feedbacks: [],
			} as unknown as CompanionStaticUpgradeProps<ModuleConfig, undefined>,
		)
	}

	it('moves the stored value from ip to mac', () => {
		const result = runConfig({ ip: '169.254.109.120', interval: 1000, timeoutInterval: 3000, verbose: false })
		expect(result.updatedConfig).toEqual({
			mac: '169.254.109.120',
			interval: 1000,
			timeoutInterval: 3000,
			verbose: false,
		})
	})

	it('drops the old key rather than leaving both', () => {
		const result = runConfig({ ip: '10.1.1.40' })
		expect(result.updatedConfig).not.toHaveProperty('ip')
	})

	it('carries the other settings through untouched', () => {
		const result = runConfig({ ip: '10.1.1.40', interval: 250, timeoutInterval: 9000, verbose: true })
		expect(result.updatedConfig).toMatchObject({ interval: 250, timeoutInterval: 9000, verbose: true })
	})

	it('preserves the "all interfaces" choice', () => {
		expect(runConfig({ ip: '' })?.updatedConfig).toEqual({ mac: '' })
	})

	it('does not overwrite a mac that is already set', () => {
		const result = runConfig({ ip: '10.1.1.40', mac: 'dc:04:5a:06:41:44|169.254.109.120' })
		expect(result.updatedConfig).toEqual({ mac: 'dc:04:5a:06:41:44|169.254.109.120' })
	})

	it('leaves an already-migrated config alone', () => {
		expect(runConfig({ mac: 'dc:04:5a:06:41:44|169.254.109.120' })?.updatedConfig).toBeNull()
	})

	it('handles a connection with no config at all', () => {
		expect(runConfig(null)?.updatedConfig).toBeNull()
	})

	it('does not touch actions or feedbacks', () => {
		const result = runConfig({ ip: '10.1.1.40' })
		expect(result.updatedActions).toEqual([])
		expect(result.updatedFeedbacks).toEqual([])
	})
})

describe('create-variables option default', () => {
	function runConfig(config: Record<string, unknown> | null) {
		return defaultVariablesOption(
			{} as CompanionUpgradeContext<ModuleConfig>,
			{
				config,
				secrets: null,
				actions: [],
				feedbacks: [],
			} as unknown as CompanionStaticUpgradeProps<ModuleConfig, undefined>,
		)
	}

	it('turns variables on for a connection created before the option existed', () => {
		// they were unconditional then, so anything else would silently remove a user's variables
		const result = runConfig({ mac: '', interval: 1000, timeoutInterval: 3000, verbose: false })
		expect(result.updatedConfig).toMatchObject({ variables: true })
	})

	it('carries the other settings through untouched', () => {
		const result = runConfig({ mac: 'aa|1.2.3.4', interval: 250, timeoutInterval: 9000, verbose: true })
		expect(result.updatedConfig).toEqual({
			mac: 'aa|1.2.3.4',
			interval: 250,
			timeoutInterval: 9000,
			verbose: true,
			variables: true,
		})
	})

	it('leaves a connection that has already chosen alone', () => {
		expect(runConfig({ variables: false })?.updatedConfig).toBeNull()
		expect(runConfig({ variables: true })?.updatedConfig).toBeNull()
	})

	it('handles a connection with no config at all', () => {
		expect(runConfig(null)?.updatedConfig).toBeNull()
	})

	it('does not touch actions or feedbacks', () => {
		const result = runConfig({ mac: '' })
		expect(result.updatedActions).toEqual([])
		expect(result.updatedFeedbacks).toEqual([])
	})
})

describe('interval bounds', () => {
	function runConfig(config: Record<string, unknown> | null) {
		return applyIntervalMinimums(
			{} as CompanionUpgradeContext<ModuleConfig>,
			{
				config,
				secrets: null,
				actions: [],
				feedbacks: [],
			} as unknown as CompanionStaticUpgradeProps<ModuleConfig, undefined>,
		)
	}

	it('raises values that predate the minimums', () => {
		const result = runConfig({ interval: 10, timeoutInterval: 50 })
		expect(result.updatedConfig).toMatchObject({
			interval: UPDATE_MINIMUM,
			timeoutInterval: TIMEOUT_MINIMUM,
		})
	})

	it('raises 0, which used to mean "off"', () => {
		const result = runConfig({ interval: 0, timeoutInterval: 0 })
		expect(result.updatedConfig).toMatchObject({
			interval: UPDATE_MINIMUM,
			timeoutInterval: TIMEOUT_MINIMUM,
		})
	})

	it('leaves a configuration already at or above the minimums alone', () => {
		expect(runConfig({ interval: UPDATE_MINIMUM, timeoutInterval: TIMEOUT_MINIMUM })?.updatedConfig).toBeNull()
		expect(runConfig({ interval: 5000, timeoutInterval: 30000 })?.updatedConfig).toBeNull()
	})

	it('raises only the field that is too low', () => {
		const result = runConfig({ interval: 5000, timeoutInterval: 10 })
		expect(result.updatedConfig).toMatchObject({ interval: 5000, timeoutInterval: TIMEOUT_MINIMUM })
	})

	it('carries the other settings through untouched', () => {
		const result = runConfig({ mac: 'aa|1.2.3.4', interval: 0, timeoutInterval: 0, variables: false, verbose: true })
		expect(result.updatedConfig).toMatchObject({ mac: 'aa|1.2.3.4', variables: false, verbose: true })
	})

	it('handles a connection with no config at all', () => {
		expect(runConfig(null)?.updatedConfig).toBeNull()
	})

	it('does not touch actions or feedbacks', () => {
		const result = runConfig({ interval: 0, timeoutInterval: 0 })
		expect(result.updatedActions).toEqual([])
		expect(result.updatedFeedbacks).toEqual([])
	})

	it('lowers values that predate the maximums', () => {
		// an hour between polls left an unplugged device looking healthy for two
		const result = runConfig({ interval: 3600000, timeoutInterval: 3600000 })
		expect(result.updatedConfig).toMatchObject({
			interval: UPDATE_MAXIMUM,
			timeoutInterval: TIMEOUT_MAXIMUM,
		})
	})

	it('leaves a configuration already inside the range alone', () => {
		expect(runConfig({ interval: UPDATE_MAXIMUM, timeoutInterval: TIMEOUT_MAXIMUM })?.updatedConfig).toBeNull()
	})

	it('lowers only the field that is too high', () => {
		const result = runConfig({ interval: 3600000, timeoutInterval: 30000 })
		expect(result.updatedConfig).toMatchObject({ interval: UPDATE_MAXIMUM, timeoutInterval: 30000 })
	})

	it('leaves every result inside the range the config fields accept', () => {
		for (const value of [0, 10, 250, 1000, 60000, 300000, 3600000, Number.MAX_SAFE_INTEGER]) {
			const result = runConfig({ interval: value, timeoutInterval: value })
			const config = result.updatedConfig ?? { interval: value, timeoutInterval: value }
			expect(config.interval, `interval from ${value}`).toBeGreaterThanOrEqual(UPDATE_MINIMUM)
			expect(config.interval, `interval from ${value}`).toBeLessThanOrEqual(UPDATE_MAXIMUM)
			expect(config.timeoutInterval, `timeout from ${value}`).toBeGreaterThanOrEqual(TIMEOUT_MINIMUM)
			expect(config.timeoutInterval, `timeout from ${value}`).toBeLessThanOrEqual(TIMEOUT_MAXIMUM)
		}
	})
})

/** Enough of an instance for `UpdateActions` to build the refresh picker. */
function mockInstanceWithDevices(): DanteInstance {
	return {
		devicesData: { '10.0.0.5': { name: 'DeviceA', ports: { ARC: 4440 } } },
		devicesChoices: [{ id: 'DeviceA', label: 'DeviceA' }],
		rxChannelsChoices: {},
		txChannelsChoices: {},
		setActionDefinitions: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

describe('refresh device option upgrade script', () => {
	function runRefresh(actions: CompanionMigrationAction[]) {
		return addRefreshDeviceOption({} as CompanionUpgradeContext<ModuleConfig>, {
			config: null,
			secrets: null,
			actions,
			feedbacks: [],
		})
	}

	it('defaults a refresh action saved before the picker existed to all devices', () => {
		// it took no options at all and always refreshed everything, so "all" preserves its behaviour
		const existing = action('refresh', {})
		const result = runRefresh([existing])

		expect(result.updatedActions).toEqual([existing])
		expect(existing.options.device).toEqual({ value: REFRESH_ALL, isExpression: false })
	})

	it('leaves a refresh action that already names a device alone', () => {
		const existing = action('refresh', { device: { value: 'DeviceA', isExpression: false } })
		const result = runRefresh([existing])

		expect(result.updatedActions).toEqual([])
		expect(existing.options.device).toEqual({ value: 'DeviceA', isExpression: false })
	})

	it('leaves an existing all-devices selection alone', () => {
		const existing = action('refresh', { device: { value: REFRESH_ALL, isExpression: false } })
		expect(runRefresh([existing]).updatedActions).toEqual([])
	})

	it('leaves an expression alone rather than replacing it with the sentinel', () => {
		const existing = action('refresh', { device: { value: '$(dante:target)', isExpression: true } })
		expect(runRefresh([existing]).updatedActions).toEqual([])
	})

	it('does not touch other actions', () => {
		const other = action('clearCrosspoint', { destinationChannelNumber: '1' })
		const result = runRefresh([other])

		expect(result.updatedActions).toEqual([])
		expect(other.options.device).toBeUndefined()
	})

	it('leaves the config and feedbacks alone', () => {
		const result = runRefresh([action('refresh', {})])

		expect(result.updatedConfig).toBeNull()
		expect(result.updatedFeedbacks).toEqual([])
	})

	it('produces a value the rebuilt dropdown actually offers', () => {
		// a dropdown whose stored value matches no choice fails to parse, taking the action with it
		const existing = action('refresh', {})
		runRefresh([existing])

		const self = mockInstanceWithDevices()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const picker = definitions.refresh.options.find((option: { id: string }) => option.id === 'device')

		const stored = existing.options.device as unknown as { value: string }
		expect(picker.choices.map((choice: { id: string }) => choice.id)).toContain(stored.value)
	})
})
