import { describe, expect, it, vi } from 'vitest'
import { UpdateActions } from '../actions.js'
import { UpdateFeedbacks } from '../feedbacks.js'
import type { DevicesData } from '../api/index.js'
import type DanteInstance from '../main.js'

/**
 * Companion requires that any option referenced from another option's `isVisibleExpression` has
 * `disableAutoExpression: true`, otherwise the referencing expression cannot read its value.
 *
 * These tests walk the definitions this module actually generates rather than its source text, so
 * they cover the per-device option fields that are built dynamically from `devicesData`.
 */

/** The option lists a fully-featured device reports once its settings replies arrive. */
const settingsOptions = {
	srOptions: ['44100', '48000'],
	pullupOptions: ['0', '1'],
	encodingOptions: ['16', '24'],
}

/** Two devices with channels, so the per-device dynamic option fields are generated. */
function devicesData(): DevicesData {
	const channels = (count: number, prefix: string) => {
		const io: Record<string | number, unknown> = { count }
		for (let i = 1; i <= count; i++) io[i] = { number: i, name: `${prefix} ${i}` }
		return io
	}
	return {
		'10.0.0.5': {
			name: 'DeviceA',
			ports: { ARC: 4440 },
			rx: channels(4, 'In'),
			tx: channels(4, 'Out'),
			...settingsOptions,
		},
		'10.0.0.6': {
			name: 'DeviceB',
			ports: { ARC: 4440 },
			rx: channels(2, 'In'),
			tx: channels(2, 'Out'),
			...settingsOptions,
		},
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
	label?: string
	type?: string
	choices?: { id: string | number; label: string }[]
	default?: unknown
	isVisibleExpression?: string
	disableAutoExpression?: boolean
	expressionDescription?: string
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

			if (!option.choices.some((choice) => choice.id === option.default)) {
				bad.push(`${definitionId}.${option.id} (default ${JSON.stringify(option.default)} not in choices)`)
			}
		}
	}
	return bad
}

describe('device dropdowns exclude devices that cannot perform the action', () => {
	/** A controller-style device: discovered and nameable, but with no audio channels at all. */
	function withController() {
		const self = mockInstance()
		self.devicesData['10.0.0.1'] = { name: 'AController', ports: { ARC: 4440 } }
		self.devicesChoices = [{ id: '10.0.0.1', label: 'AController' }, ...self.devicesChoices]
		return self
	}

	/** The device picker of an action, which is named `device` or `destinationDevice` depending on the action. */
	function deviceOption(definitions: Record<string, DefinitionLike>, actionId: string) {
		const options = definitions[actionId]?.options ?? []
		const found = options.find((option) => option.id === 'device' || option.id === 'destinationDevice')
		expect(found, `${actionId} has no device picker`).toBeDefined()
		return found
	}

	const audioActions = ['setLatency', 'setSampleRate', 'setSampleRateCustom', 'setPullup', 'setEncoding']

	it.each(audioActions)('%s does not offer a device with no audio channels', (actionId) => {
		const self = withController()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		const ids = deviceOption(definitions, actionId)?.choices?.map((choice) => choice.id) ?? []
		expect(ids).not.toContain('10.0.0.1')
		expect(ids).toContain('10.0.0.5')
	})

	it.each(audioActions)('%s does not default to a device with no audio channels', (actionId) => {
		const self = withController()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		// the controller sorts first, so an unfiltered default would land on it
		expect(deviceOption(definitions, actionId)?.default).not.toBe('10.0.0.1')
	})

	it('still offers every device for renaming, including one with no audio channels', () => {
		const self = withController()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		for (const actionId of ['setDeviceName', 'resetDeviceName']) {
			const ids = deviceOption(definitions, actionId)?.choices?.map((choice) => choice.id) ?? []
			expect(ids).toContain('10.0.0.1')
		}
	})
})

describe('settings actions offer only devices that support the setting', () => {
	/** Devices as they actually report: one supports 4 sample rates, one only 48k, neither pullup. */
	function withRealisticOptions() {
		const self = mockInstance()
		// as the real devices report: differing sample rates, and neither supporting pullup
		Object.assign(self.devicesData['10.0.0.5'], {
			srOptions: ['44100', '48000', '88200', '96000'],
			encodingOptions: ['16', '24', '32'],
			pullupOptions: undefined,
		})
		Object.assign(self.devicesData['10.0.0.6'], {
			srOptions: ['48000'],
			encodingOptions: ['32', '16', '24'],
			pullupOptions: undefined,
		})
		return self
	}

	function devicePicker(definitions: Record<string, DefinitionLike>, actionId: string) {
		const options = definitions[actionId]?.options ?? []
		return options.find((option) => option.id === 'device' || option.id === 'destinationDevice')
	}

	function deviceIds(definitions: Record<string, DefinitionLike>, actionId: string) {
		return devicePicker(definitions, actionId)?.choices?.map((choice) => choice.id) ?? []
	}

	function build(self: DanteInstance) {
		UpdateActions(self)
		return (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, DefinitionLike>
	}

	it('offers both devices for sample rate and encoding, which they report options for', () => {
		const definitions = build(withRealisticOptions())
		expect(deviceIds(definitions, 'setSampleRate').sort()).toEqual(['10.0.0.5', '10.0.0.6'])
		expect(deviceIds(definitions, 'setEncoding').sort()).toEqual(['10.0.0.5', '10.0.0.6'])
	})

	it('offers only an explanatory placeholder for pullup when no device supports it', () => {
		const definitions = build(withRealisticOptions())
		// not an empty list: Companion cannot parse a dropdown whose value matches no choice, which
		// would break the action and its learn rather than merely showing nothing
		const picker = devicePicker(definitions, 'setPullup')
		expect(picker?.choices).toHaveLength(1)
		expect(picker?.choices?.[0].id).toBe('')
		expect(picker?.choices?.[0].label).toMatch(/no devices/i)
	})

	it('offers only the device that does support pullup', () => {
		const self = withRealisticOptions()
		Object.assign(self.devicesData['10.0.0.6'], { pullupOptions: ['0', '1'] })
		const definitions = build(self)
		expect(deviceIds(definitions, 'setPullup')).toEqual(['10.0.0.6'])
	})

	it('still offers audio devices for latency, which has no reported option list', () => {
		const definitions = build(withRealisticOptions())
		expect(deviceIds(definitions, 'setLatency').sort()).toEqual(['10.0.0.5', '10.0.0.6'])
	})

	it('offers only the placeholder before any settings reply has arrived', () => {
		// the state during startup, and the state when no settings replies arrive at all
		const self = mockInstance()
		for (const device of Object.values(self.devicesData)) {
			Object.assign(device, { srOptions: undefined, encodingOptions: undefined, pullupOptions: undefined })
		}
		const definitions = build(self)
		expect(deviceIds(definitions, 'setSampleRate')).toEqual([''])
		expect(deviceIds(definitions, 'setEncoding')).toEqual([''])
	})
})

describe('no dropdown is emitted without choices', () => {
	/**
	 * Companion validates a dropdown's value against its choices and refuses to parse the whole
	 * entity when one does not match - so an option with an empty choice list breaks the action
	 * outright, including its learn, not just that one field.
	 */
	function emptyDropdowns(definitions: Record<string, DefinitionLike>): string[] {
		const bad: string[] = []
		for (const [definitionId, definition] of Object.entries(definitions)) {
			for (const option of definition.options ?? []) {
				if (option.type === 'dropdown' && option.choices?.length === 0) {
					bad.push(`${definitionId}.${option.id}`)
				}
			}
		}
		return bad
	}

	it('holds for actions with fully populated devices', () => {
		const self = mockInstance()
		UpdateActions(self)
		expect(emptyDropdowns((self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual([])
	})

	it('holds for feedbacks', () => {
		const self = mockInstance()
		UpdateFeedbacks(self)
		expect(emptyDropdowns((self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual([])
	})

	it('holds when a controller-style device reports nothing at all', () => {
		// the case that broke setSampleRate: a device with no channels and no settings options still
		// had per-device dropdowns generated for it, each with an empty choice list
		const self = mockInstance()
		self.devicesData['10.0.0.1'] = { name: 'AController', ports: {} }
		self.devicesChoices = [{ id: '10.0.0.1', label: 'AController' }, ...self.devicesChoices]
		UpdateActions(self)
		expect(emptyDropdowns((self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual([])
	})

	it('holds when a device has channels but its choice lists have not been built yet', () => {
		const self = mockInstance()
		self.rxChannelsChoices = {}
		self.txChannelsChoices = {}
		UpdateActions(self)
		expect(emptyDropdowns((self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual([])
	})

	it('holds when no device supports a setting', () => {
		const self = mockInstance()
		for (const device of Object.values(self.devicesData)) {
			Object.assign(device, { srOptions: undefined, pullupOptions: undefined, encodingOptions: undefined })
		}
		UpdateActions(self)
		expect(emptyDropdowns((self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual([])
	})
})

describe('the "None" channel choice', () => {
	function options(actionId: string) {
		const self = mockInstance()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
		return (definitions[actionId]?.options ?? []) as OptionLike[]
	}

	function channelOptions(actionId: string, prefix: string) {
		return options(actionId).filter((option) => option.id.startsWith(prefix))
	}

	it('is offered on the source channel, where it means "clear the crosspoint"', () => {
		const sources = channelOptions('makeCrosspointDropDown', 'sourceChannel_')
		expect(sources.length).toBeGreaterThan(0)
		for (const option of sources) {
			expect(option.choices?.[0]).toEqual({ id: 0, label: 'None (clear the crosspoint)' })
		}
	})

	it('still defaults to a real channel rather than to None', () => {
		for (const option of channelOptions('makeCrosspointDropDown', 'sourceChannel_')) {
			expect(option.default).toBe(1)
		}
	})

	it('is not offered on the destination channel, where it would only mean "do nothing"', () => {
		for (const option of channelOptions('makeCrosspointDropDown', 'destinationChannel_')) {
			expect(option.choices?.map((choice) => choice.id)).not.toContain(0)
		}
	})

	it.each(['setRxChannelName', 'setTxChannelName', 'clearCrosspointDropDown', 'setOutputLevel'])(
		'is not offered by %s',
		(actionId) => {
			const channels = options(actionId).filter(
				(option) => option.type === 'dropdown' && /^(channel|destinationChannel)_/.test(option.id),
			)
			expect(channels.length).toBeGreaterThan(0)
			for (const option of channels) {
				expect(option.choices?.map((choice) => choice.id)).not.toContain(0)
			}
		},
	)
})

describe('per-device fields work for a device stored by address', () => {
	/**
	 * An action saved before devices were keyed by name holds an address in its device picker.
	 * `allowCustom` keeps that parseable, but the per-device fields are declared keyed by name - so
	 * without an address arm in their visibility expressions, no channel picker would ever appear.
	 */
	function build() {
		const self = mockInstance()
		UpdateActions(self)
		return (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, DefinitionLike>
	}

	function expressionsFor(actionId: string, prefix: string) {
		return (build()[actionId]?.options ?? [])
			.filter((option) => option.id.startsWith(prefix))
			.map((option) => option.isVisibleExpression ?? '')
	}

	const cases: [string, string, string][] = [
		['setRxChannelName', 'channel_', 'device'],
		['setTxChannelName', 'channel_', 'device'],
		['clearCrosspointDropDown', 'destinationChannel_', 'destinationDevice'],
		['makeCrosspointDropDown', 'destinationChannel_', 'destinationDevice'],
		['makeCrosspointDropDown', 'sourceChannel_', 'sourceDevice'],
		['setSampleRate', 'sr_', 'device'],
		['setPullup', 'pullup_', 'device'],
		['setEncoding', 'encoding_', 'device'],
	]

	it.each(cases)('%s %s matches the device by name', (actionId, prefix, picker) => {
		const expressions = expressionsFor(actionId, prefix)
		expect(expressions.length).toBeGreaterThan(0)
		expect(expressions.some((e) => e.includes(`$(options:${picker}) == 'DeviceA'`))).toBe(true)
	})

	it.each(cases)('%s %s also matches the device by address', (actionId, prefix) => {
		const expressions = expressionsFor(actionId, prefix)
		expect(expressions.some((e) => e.includes(`== '10.0.0.5'`))).toBe(true)
	})

	it('keeps the clearAll condition alongside the two device arms', () => {
		const [expression] = expressionsFor('clearCrosspointDropDown', 'destinationChannel_')
		// the device arms must be bracketed, or `||` would swallow the `&&`
		expect(expression).toMatch(/^\(.*\) && !\$\(options:clearAll\)$/)
	})
})

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

/**
 * A channel picker switched to expression mode shows no choices, so its `expressionDescription` is
 * the only thing telling the user what the expression has to produce. Every one of them needs it,
 * and a new action gaining a channel dropdown must not quietly ship without one.
 */
function channelDropdowns(definitions: Record<string, DefinitionLike>): [string, OptionLike][] {
	const found: [string, OptionLike][] = []
	for (const [definitionId, definition] of Object.entries(definitions)) {
		for (const option of definition.options ?? []) {
			if (option.type !== 'dropdown') continue
			if (!/^(destination|source)?[Cc]hannel_/.test(option.id)) continue
			found.push([definitionId, option])
		}
	}
	return found
}

describe('channel dropdowns state their range in expression mode', () => {
	function pickers(build: (self: DanteInstance) => void, setter: 'setActionDefinitions' | 'setFeedbackDefinitions') {
		const self = mockInstance()
		build(self)
		return channelDropdowns((self[setter] as ReturnType<typeof vi.fn>).mock.calls[0][0])
	}

	const actionPickers = pickers(UpdateActions, 'setActionDefinitions')
	const feedbackPickers = pickers(UpdateFeedbacks, 'setFeedbackDefinitions')

	it('finds the channel dropdowns it means to check', () => {
		// a rename that stopped these matching would make every assertion below vacuous
		expect(actionPickers.length).toBeGreaterThan(0)
		expect(feedbackPickers.length).toBeGreaterThan(0)
	})

	it.each(
		[...actionPickers, ...feedbackPickers].map(([id, option]): [string, OptionLike] => [`${id}.${option.id}`, option]),
	)('%s has an expressionDescription', (name, option) => {
		expect(option.expressionDescription, name).toBeTypeOf('string')
	})

	it('names the range that matches the choices offered', () => {
		for (const [definitionId, option] of [...actionPickers, ...feedbackPickers]) {
			const real = (option.choices ?? []).filter((choice) => choice.id !== 0)
			expect(option.expressionDescription, `${definitionId}.${option.id}`).toContain(`to ${real.length}`)
		}
	})

	it('starts the range at 0 only where 0 clears the crosspoint', () => {
		for (const [definitionId, option] of [...actionPickers, ...feedbackPickers]) {
			const offersNone = (option.choices ?? []).some((choice) => choice.id === 0)
			const description = option.expressionDescription ?? ''
			expect(description.includes('from 0'), `${definitionId}.${option.id}`).toBe(offersNone)
			expect(description.includes('clears the crosspoint'), `${definitionId}.${option.id}`).toBe(offersNone)
		}
	})

	it('names the device the range belongs to, since channel counts differ per device', () => {
		for (const [definitionId, option] of [...actionPickers, ...feedbackPickers]) {
			const deviceName = option.id.slice(option.id.indexOf('_') + 1)
			expect(option.expressionDescription, `${definitionId}.${option.id}`).toContain(deviceName)
		}
	})
})
