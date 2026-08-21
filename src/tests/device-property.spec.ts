import { describe, expect, it, vi } from 'vitest'
import { UpdateFeedbacks } from '../feedbacks.js'
import { CheckVariables, UpdateVariableDefinitions } from '../variables.js'
import {
	DEVICE_PROPERTIES,
	DEVICE_PROPERTY_LABELS,
	deviceProperty,
	parseReply,
	scheduleCheckFeedbacks,
	type DevicesData,
} from '../api/index.js'
import type DanteInstance from '../main.js'

const A = '10.0.0.5'
const CONTROLLER = '10.0.0.1'

function devicesData(): DevicesData {
	return {
		[CONTROLLER]: { name: 'AController', ports: {} },
		[A]: {
			name: 'DeviceA',
			ports: { ARC: 4440 },
			locked: false,
			sr: 48000,
			latency: 2,
			pullup: 'NONE',
			encoding: 'PCM24',
			output_levels: ['+4dBu'],
			modelName: 'Model One',
			productVersionString: '1.2.3',
			manufacturer: 'T&M Media Pty Ltd',
			manfShortName: 'TMMedia',
			softwareVersionMajor: 4,
			softwareVersionMinor: 3,
			softwareVersionPatch: 67,
			softwareVersionBuild: 0,
			danteSoftwareVersionBuild: 8,
			hardwareVersionBuild: 0,
			danteModel: 'Brooklyn-3',
			danteSoftwareVersionMajor: 4,
			danteSoftwareVersionMinor: 3,
			danteSoftwareVersionPatch: 1,
			hardwareVersionMajor: 4,
			hardwareVersionMinor: 2,
			hardwareVersionPatch: 3,
			rx: { count: 2, 1: { number: 1, name: 'In 1' }, 2: { number: 2, name: 'In 2' } },
			tx: { count: 2, 1: { number: 1, name: '01' }, 2: { number: 2, name: '02', friendlyName: 'Talkback' } },
		},
	}
}

function instance(data: DevicesData = devicesData()) {
	const self = {
		// a normal connection: variables enabled, as every existing one is after the upgrade
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		devicesData: data,
		devicesChoices: Object.entries(data).map(([, device]) => ({ id: device.name!, label: device.name! })),
		rxChannelsChoices: {},
		txChannelsChoices: {},
		setFeedbackDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkFeedbacksById: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
	return self
}

function definition(self: DanteInstance = instance()) {
	UpdateFeedbacks(self)
	const definitions = (self.setFeedbackDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
	return definitions.device_property
}

/** Runs the feedback callback for one device/property pair. */
function read(property: string, device = 'DeviceA', self: DanteInstance = instance()) {
	return definition(self).callback({ id: `fb-${property}`, options: { device, property } }, {})
}

describe('Device Property feedback', () => {
	it('is a value feedback with the requested name', () => {
		const definitions = definition()
		expect(definitions.type).toBe('value')
		expect(definitions.name).toBe('Device Property')
	})

	it('offers every device, not only sources or destinations', () => {
		// the controller has no channels at all and is still offered
		const picker = definition().options.find((option: { id: string }) => option.id === 'device')
		expect(picker.choices.map((choice: { id: string }) => choice.id)).toEqual(['AController', 'DeviceA'])
	})

	it('accepts a custom device value, as the actions do', () => {
		const picker = definition().options.find((option: { id: string }) => option.id === 'device')
		expect(picker.allowCustom).toBe(true)
	})

	it('offers exactly the properties that are mapped to variables', () => {
		const picker = definition().options.find((option: { id: string }) => option.id === 'property')
		expect(picker.choices.map((choice: { id: string }) => choice.id)).toEqual([...DEVICE_PROPERTIES])
		expect(picker.choices.every((choice: { label: string }) => choice.label.length > 0)).toBe(true)
	})

	it('offers the properties in alphabetical order', () => {
		const picker = definition().options.find((option: { id: string }) => option.id === 'property')
		const ids = picker.choices.map((choice: { id: string }) => choice.id)
		expect(ids).toEqual([...ids].sort())
	})

	it('defaults to a useful property rather than whichever sorts first', () => {
		const picker = definition().options.find((option: { id: string }) => option.id === 'property')
		expect(picker.default).toBe('ip')
		expect(picker.choices.map((choice: { id: string }) => choice.id)).toContain(picker.default)
	})

	it('lists the accepted values in the same order the picker offers them', () => {
		const picker = definition().options.find((option: { id: string }) => option.id === 'property')
		const fromDescription = picker.expressionDescription.replace(/^[^:]*:\s*/, '').split(', ')
		expect(fromDescription).toEqual(picker.choices.map((choice: { id: string }) => choice.id))
	})

	it('lists every accepted value in the expression description', () => {
		// in expression mode there is no picker, so the accepted values have to be written out
		const picker = definition().options.find((option: { id: string }) => option.id === 'property')
		expect(picker.expressionDescription).toBeTruthy()
		for (const property of DEVICE_PROPERTIES) {
			expect(picker.expressionDescription).toContain(property)
		}
	})

	it('labels every property', () => {
		for (const property of DEVICE_PROPERTIES) {
			expect(DEVICE_PROPERTY_LABELS[property]).toBeTruthy()
		}
	})

	it.each([
		['ip', A],
		['model_name', 'Model One'],
		['product_version', '1.2.3'],
		['sr', 48000],
		['latency', 2],
		['pullup', 'NONE'],
		['encoding', 'PCM24'],
		['rx', 2],
		['tx', 2],
		['locked', false],
	])('reports %s', (property, expected) => {
		expect(read(property)).toEqual(expected)
	})

	it.each([
		['dante_model', 'Brooklyn-3'],
		['dante_software_version', '4.3.1'],
		['hardware_version', '4.2.3'],
	])('reports %s from the versions reply', (property, expected) => {
		expect(read(property)).toBe(expected)
	})

	it.each([
		['manufacturer', 'T&M Media Pty Ltd'],
		['manufacturer_short', 'TMMedia'],
		['software_version', '4.3.67'],
		['software_build', 0],
		['dante_software_build', 8],
		['hardware_build', 0],
	])('reports %s', (property, expected) => {
		expect(read(property)).toBe(expected)
	})

	it('reports a zero build as 0, not as absent', () => {
		// a real device reports build 0, which must not be confused with "not reported"
		expect(read('software_build')).toBe(0)
		expect(read('software_build', 'AController')).toBe('')
	})

	it('falls back to the numeric product version when the string one is empty', () => {
		// devices report an empty string here as readily as nothing, and an empty version is absence
		const data = devicesData()
		Object.assign(data[A], {
			productVersionString: '',
			productVersionMajor: 4,
			productVersionMinor: 3,
			productVersionPatch: 67,
		})
		expect(read('product_version', 'DeviceA', instance(data))).toBe('4.3.67')
	})

	it('reports nothing rather than "undefined.undefined.undefined" for an unreported version', () => {
		expect(read('hardware_version', 'AController')).toBe('')
	})

	it('reports channel names as the variables hold them', () => {
		expect(read('rx_names')).toEqual(['In 1', 'In 2'])
		// tx uses the channel label where there is one, matching getChannelSubscriptionName
		expect(read('tx_names')).toEqual(['01', 'Talkback'])
	})

	it('accepts a device stored by address, as older configurations hold it', () => {
		expect(read('model_name', A)).toBe('Model One')
	})

	it('reports nothing for an unknown device', () => {
		expect(read('ip', 'Nope')).toBe('')
	})

	it('reports nothing for a property this build does not have', () => {
		expect(read('not_a_property')).toBe('')
	})

	it('reports nothing rather than undefined for a property the device has not sent', () => {
		expect(read('sr', 'AController')).toBe('')
	})

	it('records the device it reads, so a change to it re-checks this feedback by id', () => {
		const self = instance()
		// evaluating the feedback is what registers which device it depends on
		definition(self).callback({ id: 'fb-sr', options: { device: 'DeviceA', property: 'sr' } }, {})

		scheduleCheckFeedbacks(self, A)
		const checked = (self.checkFeedbacksById as ReturnType<typeof vi.fn>).mock.calls.flat()
		expect(checked).toContain('fb-sr')
	})

	it('is not re-checked when an unrelated device changes', () => {
		const self = instance()
		definition(self).callback({ id: 'fb-sr', options: { device: 'DeviceA', property: 'sr' } }, {})

		scheduleCheckFeedbacks(self, CONTROLLER)
		const checked = (self.checkFeedbacksById as ReturnType<typeof vi.fn>).mock.calls.flat()
		expect(checked).not.toContain('fb-sr')
	})
})

describe('the feedback and the variables cannot disagree', () => {
	it('reports the same value the corresponding variable holds', () => {
		const self = instance()
		CheckVariables(self)
		const written = (self.setVariableValues as ReturnType<typeof vi.fn>).mock.calls[0][0]

		for (const property of DEVICE_PROPERTIES) {
			const fromFeedback = read(property, 'DeviceA', instance())
			const fromVariable = written[`DeviceA_${property}`]
			// the feedback substitutes '' where a variable is simply absent
			expect(fromFeedback).toEqual(fromVariable ?? '')
		}
	})

	it('deviceProperty is the single source both read through', () => {
		const data = devicesData()
		expect(deviceProperty(data[A], A, 'model_name')).toBe('Model One')
		expect(deviceProperty(data[A], A, 'ip')).toBe(A)
	})
})

describe('property changes schedule a feedback check', () => {
	/** A real 56-byte channel-count reply: 8 tx, 8 rx, unlocked. */
	const CHANNEL_COUNT_HEX =
		'272900380001100000010ff90008000800000040004000200020000800010002000000000000000000000000000000000000000100000001'

	function withRegisteredDevice() {
		const self = instance()
		self.checkAllFeedbacks = vi.fn()
		self.setVariableValues = vi.fn()
		self.setActionDefinitions = vi.fn()
		self.setVariableDefinitions = vi.fn()
		self.checkFeedbacks = vi.fn()
		// the reply triggers follow-up channel queries, which build packets and send them
		self.counter = Buffer.alloc(2)
		self.mac = Buffer.alloc(6)
		self.sockets = { ARC: { send: vi.fn() } as never }
		self.debug = false
		return self
	}

	it('a channel-count reply schedules one, so counts and lock state reach a feedback', () => {
		// this reply carries rx/tx counts and the lock flag, and used to schedule nothing at all
		const self = withRegisteredDevice()
		const reply = Buffer.from(CHANNEL_COUNT_HEX, 'hex')
		parseReply(self, reply, { address: A, size: reply.length, port: 4440, family: 'IPv4' })

		const checked = [
			...(self.checkFeedbacksById as ReturnType<typeof vi.fn>).mock.calls,
			...(self.checkAllFeedbacks as ReturnType<typeof vi.fn>).mock.calls,
		]
		expect(checked.length).toBeGreaterThan(0)
	})
})

describe('the Create Module Variables option', () => {
	function withVariables(enabled: boolean) {
		const self = instance()
		self.config = { ...self.config, variables: enabled }
		self.setVariableDefinitions = vi.fn()
		self.setVariableValues = vi.fn()
		return self
	}

	it('publishes variables when enabled', () => {
		const self = withVariables(true)
		UpdateVariableDefinitions(self)
		CheckVariables(self)

		const definitions = (self.setVariableDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(Object.keys(definitions).length).toBeGreaterThan(1)
		expect((self.setVariableValues as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
	})

	it('writes no variable values when disabled', () => {
		const self = withVariables(false)
		CheckVariables(self)
		expect(self.setVariableValues).not.toHaveBeenCalled()
	})

	it('clears the definitions when disabled, so variables from a previous run do not linger', () => {
		const self = withVariables(false)
		UpdateVariableDefinitions(self)

		const definitions = (self.setVariableDefinitions as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(Object.keys(definitions)).toEqual([])
	})

	it('still reports device properties through the feedback when variables are off', () => {
		// the point of the option: the data is still tracked, only the variables are not created
		const self = withVariables(false)
		expect(definition(self).callback({ id: 'fb', options: { device: 'DeviceA', property: 'sr' } }, {})).toBe(48000)
	})
})
