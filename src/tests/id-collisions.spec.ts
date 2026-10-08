import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { collidingIds, sanitiseVariableId } from '../utils/sanitise.js'
import { updateData, resetIdCollisionWarnings, type DevicesData } from '../api/index.js'
import type { LoggingSink } from '@companion-module/base'
import type DanteInstance from '../main.js'

/**
 * Two device names that sanitise to the same id.
 *
 * Sanitising is lossy - 'Rack 1' and 'Rack-1' are different devices but one id - and everything
 * keyed by that id then belongs to whichever was seen last: variables overwrite each other, and a
 * per-device option field appears twice in one action with no way to tell them apart. Nothing about
 * the symptoms points at the cause, which is why it is worth saying out loud.
 */

let loggerSink: ReturnType<typeof vi.fn<LoggingSink>>

beforeEach(() => {
	loggerSink = vi.fn<LoggingSink>()
	global.COMPANION_LOGGER = loggerSink
})

afterEach(() => {
	global.COMPANION_LOGGER = undefined
})

/** The warnings a rebuild emitted about colliding ids. */
function collisionWarnings(): string[] {
	return loggerSink.mock.calls
		.filter(([, level]) => level === 'warn')
		.map(([, , message]) => String(message))
		.filter((message) => message.includes('both become'))
}

function instance(names: string[], remembered: string[] = []): DanteInstance {
	const devicesData: Record<string, unknown> = {}
	names.forEach((name, index) => {
		devicesData[`10.0.0.${index + 1}`] = { name, ports: { ARC: 4440 } }
	})
	return {
		devicesData: devicesData as unknown as DevicesData,
		devicesChoices: names.map((name) => ({ id: name, label: name })),
		rxChannelsChoices: Object.fromEntries(remembered.map((name) => [name, [{ id: 1, label: 'In 1' }]])),
		txChannelsChoices: {},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		config: { variables: true, interval: 1000, timeoutInterval: 3000, verbose: false },
		debug: false,
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkAllFeedbacks: vi.fn(),
		checkFeedbacksById: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

describe('collidingIds', () => {
	it('finds names that sanitise to one id', () => {
		// a space and an underscore both land on '_', which is the realistic field case
		expect([...collidingIds(['Rack 1', 'Rack_1']).entries()]).toEqual([['Rack_1', ['Rack 1', 'Rack_1']]])
	})

	it('says nothing about names that stay distinct', () => {
		// hyphens and dots survive sanitising, so these are three different ids
		expect(collidingIds(['Rack-1', 'Rack.1', 'Studio A']).size).toBe(0)
	})

	it('does not treat one name seen twice as a collision', () => {
		// a device announcing from two addresses reaches this twice under the same name
		expect(collidingIds(['Rack 1', 'Rack 1']).size).toBe(0)
	})

	it('groups three or more names onto the same id', () => {
		const collisions = collidingIds(['Rack 1', 'Rack_1', 'Rack:1', 'Rack-1'])
		expect(collisions.get('Rack_1')).toEqual(['Rack 1', 'Rack_1', 'Rack:1'])
		// '-' survives sanitising, so 'Rack-1' is genuinely a different id and not part of the group
		expect(sanitiseVariableId('Rack-1')).toBe('Rack-1')
	})

	it('ignores names that need no sanitising at all', () => {
		expect(collidingIds([]).size).toBe(0)
		expect(collidingIds(['OnlyOne']).size).toBe(0)
	})
})

describe('a rebuild warns about colliding device ids', () => {
	it('names both devices, the id they share, and what to do', () => {
		updateData(instance(['Rack 1', 'Rack_1']))

		const [warning] = collisionWarnings()
		expect(warning).toContain("'Rack 1'")
		expect(warning).toContain("'Rack_1'")
		expect(warning).toContain("'Rack_1'")
		expect(warning).toMatch(/rename/i)
	})

	it('stays quiet when every device keeps its own id', () => {
		updateData(instance(['Rack-1', 'Rack.1']))
		expect(collisionWarnings()).toEqual([])
	})

	it('says it once, not on every rebuild', () => {
		const self = instance(['Rack 1', 'Rack_1'])
		for (let i = 0; i < 5; i++) updateData(self)
		expect(collisionWarnings()).toHaveLength(1)
	})

	it('speaks again when a third device joins the same collision', () => {
		const self = instance(['Rack 1', 'Rack_1'])
		updateData(self)
		self.devicesData['10.0.0.3'] = { name: 'Rack:1', ports: { ARC: 4440 } }

		updateData(self)
		expect(collisionWarnings()).toHaveLength(2)
		expect(collisionWarnings()[1]).toContain("'Rack:1'")
	})

	it('covers a device whose channels are only remembered', () => {
		// a device that has gone offline still generates option fields, so it still collides
		updateData(instance(['Rack 1'], ['Rack_1']))
		expect(collisionWarnings()).toHaveLength(1)
	})

	it('says it again after a reconnect', () => {
		const self = instance(['Rack 1', 'Rack_1'])
		updateData(self)
		expect(collisionWarnings()).toHaveLength(1)

		resetIdCollisionWarnings(self)
		updateData(self)
		expect(collisionWarnings()).toHaveLength(2)
	})

	it('still rebuilds the definitions', () => {
		// the warning is advisory - a collision must not stop the module working
		const self = instance(['Rack 1', 'Rack_1'])
		updateData(self)
		expect(self.setActionDefinitions).toHaveBeenCalled()
		expect(self.setVariableDefinitions).toHaveBeenCalled()
		expect(self.setFeedbackDefinitions).toHaveBeenCalled()
	})
})
