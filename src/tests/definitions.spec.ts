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
			audioRx: channels(4, 'In'),
			audioTx: channels(4, 'Out'),
			...settingsOptions,
		},
		'10.0.0.6': {
			name: 'DeviceB',
			ports: { ARC: 4440 },
			audioRx: channels(2, 'In'),
			audioTx: channels(2, 'Out'),
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

	const audioActions = [
		'setLatency',
		'setSampleRate',
		'setSampleRateCustom',
		'setPullup',
		'setEncoding',
		'setOutputLevel',
	]

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

	/** A decoder: video receive channels and no audio at all, as an AV-X board reports. */
	function withVideoOnlyDecoder() {
		const self = mockInstance()
		self.devicesData['10.0.0.9'] = {
			name: 'Decoder',
			ports: { ARC: 4440 },
			videoRx: { count: 2, 1: { number: 1, name: 'V In 1' }, 2: { number: 2, name: 'V In 2' } },
		}
		self.devicesChoices = [...self.devicesChoices, { id: '10.0.0.9', label: 'Decoder' }]
		return self
	}

	it('offers a video-only device as a crosspoint destination, which is the whole point of the shared picker', () => {
		const self = withVideoOnlyDecoder()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		const ids = deviceOption(definitions, 'makeCrosspointDropDown')?.choices?.map((choice) => choice.id) ?? []
		expect(ids).toContain('10.0.0.9')
	})

	it('does not offer a video-only device an output level, which only an audio input has', () => {
		// the crosspoint pickers explain a media-type mismatch with a warning field; this action has no
		// Channel Type to hang one off, so a device it cannot serve must not be in the list at all
		const self = withVideoOnlyDecoder()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]

		const ids = deviceOption(definitions, 'setOutputLevel')?.choices?.map((choice) => choice.id) ?? []
		expect(ids).not.toContain('10.0.0.9')
		expect(ids).toContain('10.0.0.5')
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
		;(self.devicesData['10.0.0.5'] as { audioTx?: unknown }).audioTx = undefined
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

/**
 * Companion lists actions and feedbacks alphabetically, so the name has to lead with what the entry
 * acts on rather than what it does to it - otherwise every "Set ..." lands in one place and the four
 * things you can do to a crosspoint scatter across the list.
 */
describe('naming convention', () => {
	const SUBJECT_FIRST = /^[A-Z][A-Za-z0-9 ]* - [A-Z]/

	function names(build: (self: DanteInstance) => void, setter: 'setActionDefinitions' | 'setFeedbackDefinitions') {
		const self = mockInstance()
		build(self)
		const definitions = (self[setter] as ReturnType<typeof vi.fn>).mock.calls[0][0]
		return Object.values(definitions as Record<string, { name: string }>).map((definition) => definition.name)
	}

	const actionNames = names(UpdateActions, 'setActionDefinitions')
	const feedbackNames = names(UpdateFeedbacks, 'setFeedbackDefinitions')

	it('finds the definitions it means to check', () => {
		expect(actionNames.length).toBeGreaterThan(0)
		expect(feedbackNames.length).toBeGreaterThan(0)
	})

	it.each([...actionNames, ...feedbackNames])('"%s" names its subject before its verb', (name) => {
		expect(name).toMatch(SUBJECT_FIRST)
	})

	it.each([
		['actions', () => actionNames],
		['feedbacks', () => feedbackNames],
	])('every %s subject stays in one contiguous run when sorted', (_kind, get) => {
		const sorted = [...get()].sort((a, b) => a.localeCompare(b))
		const subjects = sorted.map((name) => name.slice(0, name.indexOf(' - ')))

		// a subject reappearing after a different one has intervened means the grouping is broken
		const seen = new Set<string>()
		let previous = ''
		for (const subject of subjects) {
			if (subject !== previous) {
				expect(seen.has(subject), `${subject} is split across the sorted list`).toBe(false)
				seen.add(subject)
				previous = subject
			}
		}
	})

	it('has no duplicate names, which would be indistinguishable in the picker', () => {
		for (const list of [actionNames, feedbackNames]) {
			expect(new Set(list).size).toBe(list.length)
		}
	})
})

/**
 * `(custom)` marks the variant that takes its selection as free text - typed by hand, or driven by a
 * variable or expression - rather than picking from what has been discovered. Everything else uses
 * dropdowns, so the dropdown form is the unmarked default and only the exception carries a suffix.
 *
 * These check the suffix against what the definition actually offers, not just how it is spelled: a
 * name claiming `(custom)` with no free-entry field, or a pair whose base form is the free-text one,
 * would both pass a spelling check and mislead the user.
 */
describe('the (custom) suffix', () => {
	interface Definition {
		name: string
		options?: { type?: string }[]
	}

	function definitions(
		build: (self: DanteInstance) => void,
		setter: 'setActionDefinitions' | 'setFeedbackDefinitions',
	): Definition[] {
		const self = mockInstance()
		build(self)
		return Object.values((self[setter] as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, Definition>)
	}

	const all = [
		...definitions(UpdateActions, 'setActionDefinitions'),
		...definitions(UpdateFeedbacks, 'setFeedbackDefinitions'),
	]

	/** Fields the user types into, as opposed to choosing from a list. */
	function freeEntryFields(definition: Definition): number {
		return (definition.options ?? []).filter((option) => option.type === 'textinput' || option.type === 'number').length
	}

	const SUFFIX = ' (custom)'

	it('finds the definitions it means to check', () => {
		expect(all.filter((definition) => definition.name.endsWith(SUFFIX)).length).toBeGreaterThan(0)
	})

	it('is the only suffix in use, so no "(drop down menu)" or "(manual)" creeps back', () => {
		const suffixed = all.map((definition) => definition.name).filter((name) => name.includes('('))
		expect(suffixed.every((name) => name.endsWith(SUFFIX))).toBe(true)
	})

	it.each(all.filter((definition) => definition.name.endsWith(SUFFIX)).map((d) => [d.name, d] as const))(
		'"%s" actually offers a field to type into',
		(_name, definition) => {
			expect(freeEntryFields(definition)).toBeGreaterThan(0)
		},
	)

	it.each(all.filter((definition) => definition.name.endsWith(SUFFIX)).map((d) => [d.name, d] as const))(
		'"%s" takes more by hand than the variant it is named after',
		(name, custom) => {
			// the pairing is the point: without a base form to compare against, the suffix says nothing
			const base = all.find((definition) => definition.name === name.slice(0, -SUFFIX.length))
			expect(base, `no base variant for ${name}`).toBeDefined()
			expect(freeEntryFields(custom)).toBeGreaterThan(freeEntryFields(base as Definition))
		},
	)

	it('leaves every unsuffixed variant of a pair choosing from dropdowns', () => {
		for (const custom of all.filter((definition) => definition.name.endsWith(SUFFIX))) {
			const base = all.find((definition) => definition.name === custom.name.slice(0, -SUFFIX.length))
			const dropdowns = (base?.options ?? []).filter((option) => option.type === 'dropdown').length
			expect(dropdowns, `${base?.name} offers no dropdown`).toBeGreaterThan(0)
		}
	})
})

/**
 * Companion identifies an option by its id within its definition, so two options sharing one is
 * unresolvable - the value saved under that id belongs to both fields at once.
 *
 * Every per-device option id ends in the device's *name*, while `devicesData` is keyed by address,
 * so one name reaching the module from two addresses used to declare each of those options twice.
 * That is not hypothetical: a device that changes address re-registers under the new one while the
 * old record waits out its offline timeout, and a Companion host on both a primary and a secondary
 * Dante network sees one device announce itself from each.
 */
describe('option ids are unique within a definition', () => {
	/** Returns `definitionId.optionId` for every id declared more than once. */
	function duplicateOptionIds(definitions: Record<string, DefinitionLike>): string[] {
		const bad: string[] = []
		for (const [definitionId, definition] of Object.entries(definitions)) {
			const seen = new Set<string>()
			for (const option of definition.options ?? []) {
				if (seen.has(option.id)) bad.push(`${definitionId}.${option.id}`)
				seen.add(option.id)
			}
		}
		return bad
	}

	/** Both sets of definitions this module builds, keyed by id. */
	function allDefinitions(self: DanteInstance): Record<string, DefinitionLike> {
		UpdateActions(self)
		UpdateFeedbacks(self)
		return {
			...(self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0],
			...(self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0],
		}
	}

	/** DeviceA announcing itself from a second address, as a re-registration or a second network does. */
	function withSecondAddress(overrides: Record<string, unknown> = {}) {
		const self = mockInstance()
		self.devicesData['10.0.0.7'] = { ...self.devicesData['10.0.0.5'], ...overrides }
		return self
	}

	it('holds for every action and feedback', () => {
		expect(duplicateOptionIds(allDefinitions(mockInstance()))).toEqual([])
	})

	it('holds when one device name arrives from two addresses', () => {
		expect(duplicateOptionIds(allDefinitions(withSecondAddress()))).toEqual([])
	})

	it('flags a definition declaring an id twice', () => {
		expect(duplicateOptionIds({ bad: { options: [{ id: 'channel_A' }, { id: 'channel_A' }] } })).toEqual([
			'bad.channel_A',
		])
	})

	it('still declares the per-device options of a device seen at two addresses', () => {
		const definitions = allDefinitions(withSecondAddress())
		const ids = (definitions.setSampleRate?.options ?? []).map((option) => option.id)

		expect(ids).toContain('sr_DeviceA')
	})

	it('shows the single field for either address, so an action saved against one still resolves', () => {
		const definitions = allDefinitions(withSecondAddress())
		const field = (definitions.setSampleRate?.options ?? []).find((option) => option.id === 'sr_DeviceA')

		expect(field?.isVisibleExpression).toContain("'DeviceA'")
		expect(field?.isVisibleExpression).toContain("'10.0.0.5'")
		expect(field?.isVisibleExpression).toContain("'10.0.0.7'")
	})

	it('takes the field from the address that has the data, not whichever came first', () => {
		// A device that has just re-registered has no settings replies in its record yet. Letting that
		// record represent the name would drop a field the device demonstrably supports.
		const self = mockInstance()
		// first in iteration order, so a builder taking the first record it meets picks this one
		self.devicesData = { '10.0.0.4': { name: 'DeviceA', ports: { ARC: 4440 } }, ...self.devicesData }
		const definitions = allDefinitions(self)
		const field = (definitions.setSampleRate?.options ?? []).find((option) => option.id === 'sr_DeviceA')

		expect(field?.choices?.length).toBeGreaterThan(0)
		expect(field?.isVisibleExpression).toContain("'10.0.0.4'")
	})

	it('leaves out a name no address has the data for', () => {
		const self = mockInstance()
		self.devicesData['10.0.0.1'] = { name: 'AController', ports: { ARC: 4440 } }
		const definitions = allDefinitions(self)
		const ids = (definitions.setSampleRate?.options ?? []).map((option) => option.id)

		expect(ids).not.toContain('sr_AController')
	})
})

/**
 * The crosspoint pickers are shared by audio and video, so their lists mix devices that can serve
 * the selected Channel Type with devices that cannot - by design, since a dropdown's choices cannot
 * be narrowed by the value of the option beside it. Tagging the label says which is which at the
 * moment of choosing, instead of leaving the user to pick one and read a warning afterwards.
 */
describe('device pickers say what each device carries', () => {
	/** Every media shape a picker can meet: audio only, video only, both, and one of each direction. */
	function withEveryShape() {
		const self = mockInstance()
		const io = (count: number) => ({ count, 1: { number: 1, name: 'Ch 1' } })
		Object.assign(self.devicesData['10.0.0.6'], { videoRx: io(1), videoTx: io(1) })
		self.devicesData['10.0.0.8'] = { name: 'Decoder', ports: { ARC: 4440 }, videoRx: io(1) }
		// audio one way, video the other - the case a single per-device tag would get wrong
		self.devicesData['10.0.0.9'] = { name: 'Mixed', ports: { ARC: 4440 }, audioTx: io(1), videoRx: io(1) }
		self.devicesChoices = [
			...self.devicesChoices,
			{ id: '10.0.0.8', label: 'Decoder' },
			{ id: '10.0.0.9', label: 'Mixed' },
		]
		return self
	}

	function picker(actionId: string, optionId: string) {
		const self = withEveryShape()
		UpdateActions(self)
		const definitions = (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
		const options = (definitions as Record<string, DefinitionLike>)[actionId]?.options ?? []
		const found = options.find((option) => option.id === optionId)
		expect(found, `${actionId} has no ${optionId}`).toBeDefined()
		return found?.choices ?? []
	}

	/** The label a device's own entry carries in that picker. */
	function labelFor(choices: { id: string | number; label: string }[], deviceIp: string) {
		return choices.find((choice) => choice.id === deviceIp)?.label
	}

	it('tags an audio-only device, a video-only device, and one carrying both', () => {
		const choices = picker('makeCrosspointDropDown', 'destinationDevice')

		expect(labelFor(choices, '10.0.0.5')).toBe('DeviceA (A)')
		expect(labelFor(choices, '10.0.0.8')).toBe('Decoder (V)')
		expect(labelFor(choices, '10.0.0.6')).toBe('DeviceB (AV)')
	})

	it('tags what the device offers in that direction, not what it has in total', () => {
		// Mixed transmits audio and receives video, so it is a video destination and an audio source
		expect(labelFor(picker('makeCrosspointDropDown', 'destinationDevice'), '10.0.0.9')).toBe('Mixed (V)')
		expect(labelFor(picker('makeCrosspointDropDown', 'sourceDevice'), '10.0.0.9')).toBe('Mixed (A)')
	})

	it('leaves the id alone, so an action saved before the tag existed still resolves', () => {
		const choices = picker('makeCrosspointDropDown', 'destinationDevice')

		expect(choices.map((choice) => choice.id)).toContain('10.0.0.5')
	})

	it('does not tag a list that only ever holds audio devices, where it would say nothing', () => {
		for (const [actionId, optionId] of [
			['setOutputLevel', 'device'],
			['setLatency', 'destinationDevice'],
			['setSampleRate', 'device'],
		]) {
			const labels = picker(actionId, optionId).map((choice) => choice.label)
			expect(
				labels.every((label) => !label.includes('(')),
				`${actionId} tags its labels`,
			).toBe(true)
		}
	})

	it('does not tag the lists that hold every device, media type or not', () => {
		// renaming, refreshing and reading a property work the same on a device with no channels at all
		for (const actionId of ['setDeviceName', 'resetDeviceName', 'refresh']) {
			const labels = picker(actionId, 'device').map((choice) => choice.label)
			expect(
				labels.every((label) => !label.includes('(')),
				`${actionId} tags its labels`,
			).toBe(true)
		}
	})
})

describe('option ids are sanitised', () => {
	/**
	 * Companion cannot handle an option id containing a space, and a device may be named anything -
	 * "Studio 1 (Rack A)" is an ordinary Dante name. The per-device fields are suffixed with the
	 * device name, so without sanitising, such a device makes every field it names misbehave.
	 */
	const MESSY = 'Studio 1 (Rack A)'
	const CLEAN = 'Studio_1__Rack_A_'

	/** The same two devices, with the first renamed to something Companion cannot use verbatim. */
	function messyData(): DevicesData {
		const data = devicesData()
		;(data['10.0.0.5'] as { name: string }).name = MESSY
		return data
	}

	function messyInstance() {
		const data = messyData()
		return {
			devicesData: data,
			devicesChoices: Object.entries(data).map(([ip, device]) => ({ id: ip, label: device.name! })),
			rxChannelsChoices: { [MESSY]: [{ id: 1, label: 'In 1' }], DeviceB: [{ id: 1, label: 'In 1' }] },
			txChannelsChoices: { [MESSY]: [{ id: 1, label: 'Out 1' }], DeviceB: [{ id: 1, label: 'Out 1' }] },
			setActionDefinitions: vi.fn(),
			setFeedbackDefinitions: vi.fn(),
			log: vi.fn(),
		} as unknown as DanteInstance
	}

	function allOptionIds(definitions: Record<string, DefinitionLike>): string[] {
		return Object.values(definitions).flatMap((definition) => (definition.options ?? []).map((option) => option.id))
	}

	function built() {
		const self = messyInstance()
		UpdateActions(self)
		UpdateFeedbacks(self)
		return {
			actions: (self.setActionDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				DefinitionLike
			>,
			feedbacks: (self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				DefinitionLike
			>,
		}
	}

	it('no action option id contains a character Companion rejects', () => {
		const ids = allOptionIds(built().actions)
		expect(ids.length).toBeGreaterThan(0)
		expect(ids.filter((id) => !/^[a-zA-Z0-9\-_.]+$/.test(id))).toEqual([])
	})

	it('no feedback option id contains a character Companion rejects', () => {
		const ids = allOptionIds(built().feedbacks)
		expect(ids.length).toBeGreaterThan(0)
		expect(ids.filter((id) => !/^[a-zA-Z0-9\-_.]+$/.test(id))).toEqual([])
	})

	it('actually generated fields for the messy device, rather than passing by finding none', () => {
		// guards the two sweeps above: they would pass trivially if no per-device field existed
		expect(allOptionIds(built().actions).filter((id) => id.includes(CLEAN)).length).toBeGreaterThan(0)
	})

	it.each([
		['setSampleRate', 'sr_'],
		['setPullup', 'pullup_'],
		['setEncoding', 'encoding_'],
		['setOutputLevel', 'channel_'],
		['setRxChannelName', 'channel_'],
	])('%s suffixes %s with the sanitised name', (actionId, prefix) => {
		const ids = (built().actions[actionId]?.options ?? []).map((option) => option.id)
		expect(ids).toContain(`${prefix}${CLEAN}`)
	})

	it('sanitises the channel pickers and their missing-channel warnings alike', () => {
		const ids = (built().actions.makeCrosspointDropDown?.options ?? []).map((option) => option.id)
		expect(ids).toContain(`destinationChannel_${CLEAN}`)
		expect(ids).toContain(`sourceChannel_${CLEAN}`)
		expect(ids).toContain(`destinationDeviceNoVideoRXChannels_${CLEAN}`)
	})

	it('leaves the device name itself unsanitised in choices and visibility expressions', () => {
		// the name is a value, not an id: it is what the picker stores and what the expression
		// compares against, so sanitising it here would stop the field ever showing
		const options = built().actions.setSampleRate?.options ?? []
		const field = options.find((option) => option.id === `sr_${CLEAN}`)
		expect(field?.isVisibleExpression).toContain(`$(options:device) == '${MESSY}'`)
	})
})
