import { describe, expect, it, vi, beforeEach } from 'vitest'
import type DanteInstance from '../../main.js'

/**
 * The log is the only view into a running module, so these pin the lines an operator relies on:
 * a device arriving and leaving, a rename, and a route moving. They assert what the line says, not
 * just that something was logged - a message that stops naming the device is no more use than none.
 */

const captured: { level: string; scope: string; text: string }[] = []

/**
 * Records what the api loggers emit. The modules capture their logger at import time, so the
 * factory has to be replaced before they load - hence the mock plus dynamic import below.
 */
vi.mock('@companion-module/base', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@companion-module/base')>()
	const record = (scope: string, level: string) => (text: unknown) =>
		captured.push({ level, scope, text: String(text) })
	return {
		...actual,
		createModuleLogger: (scope: string) => ({
			info: record(scope, 'info'),
			warn: record(scope, 'warn'),
			debug: record(scope, 'debug'),
			error: record(scope, 'error'),
			trace: record(scope, 'trace'),
		}),
	}
})

const { danteDiscovery, destroyDevice, parseReply, updateChannelChoices, updateDeviceChoice } =
	await import('../index.js')
const { DANTE_CONST } = await import('../const.js')
type DevicesData = import('../index.js').DevicesData

beforeEach(() => {
	captured.length = 0
})

/** The lines logged at a given level, as plain strings. */
function at(level: string): string[] {
	return captured.filter((entry) => entry.level === level).map((entry) => entry.text)
}

function instance(devicesData: DevicesData = {}, verbose = false): DanteInstance {
	return {
		devicesData,
		devicesChoices: [],
		txChannelsChoices: {},
		rxChannelsChoices: {},
		txFriendlyNameRefreshCounter: 0,
		counter: Buffer.from('0000', 'hex'),
		mac: Buffer.from('aabbccddeeff', 'hex'),
		sockets: {},
		mdns: { query: vi.fn() },
		debug: verbose,
		timeout: 3000,
		config: { mac: 'x', interval: 1000, timeoutInterval: 3000, variables: true, verbose },
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkFeedbacks: vi.fn(),
		checkFeedbacksById: vi.fn(),
		checkAllFeedbacks: vi.fn(),
		log: vi.fn(),
		updateStatus: vi.fn(),
	} as unknown as DanteInstance
}

function srvResponse(deviceName: string) {
	return {
		answers: [{ type: 'SRV' as const, name: `${deviceName}._netaudio-arc._udp.local`, data: { port: 4440 } }],
		additionals: [],
	}
}

describe('device rename', () => {
	it('replaces the old dropdown entry rather than leaving both', () => {
		// updateDeviceChoice finds the entry to remove by the name still on the device record, so
		// assigning the new name first orphaned the old choice in every dropdown
		const self = instance()
		const rinfo = { address: '10.0.0.5' } as never

		danteDiscovery(self, srvResponse('OldName'), rinfo)
		expect(self.devicesChoices.map((choice) => choice.id)).toEqual(['OldName'])

		danteDiscovery(self, srvResponse('NewName'), rinfo)
		expect(self.devicesChoices.map((choice) => choice.id)).toEqual(['NewName'])
	})

	it('logs both names, since actions stored against the old one stop resolving', () => {
		const self = instance({ '10.0.0.5': { name: 'OldName' } })

		updateDeviceChoice(self, '10.0.0.5', 'NewName')

		const line = at('info').find((text) => text.includes('renamed'))
		expect(line).toContain('OldName')
		expect(line).toContain('NewName')
		expect(line).toContain('10.0.0.5')
	})

	it('does not claim a rename when the name is merely confirmed', () => {
		const self = instance({ '10.0.0.5': { name: 'SameName' } })

		updateDeviceChoice(self, '10.0.0.5', 'SameName')

		expect(at('info').filter((text) => text.includes('renamed'))).toEqual([])
	})
})

describe('channel renames', () => {
	function withChannels(names: string[]) {
		const rx: Record<string | number, unknown> = { count: names.length }
		names.forEach((name, index) => (rx[index + 1] = { number: index + 1, name }))
		return { '10.0.0.5': { name: 'DeviceA', audioRx: rx } } as unknown as DevicesData
	}

	it('reports a renamed channel at info, naming both labels', () => {
		const self = instance(withChannels(['In 1', 'In 2']))
		updateChannelChoices(self, '10.0.0.5', 'rx')

		captured.length = 0
		self.devicesData['10.0.0.5'].audioRx![2].name = 'Talkback'
		updateChannelChoices(self, '10.0.0.5', 'rx')

		const line = at('info').find((text) => text.includes('renamed'))
		expect(line).toContain('In 2')
		expect(line).toContain('Talkback')
		expect(line).toContain('DeviceA')
	})

	it('does not log the initial channel list at info, which is not a change', () => {
		const self = instance(withChannels(['In 1', 'In 2']))
		updateChannelChoices(self, '10.0.0.5', 'rx')

		expect(at('info')).toEqual([])
	})
})

describe('device going offline', () => {
	it('says which device left and how long it was silent, without internal jargon', () => {
		const self = instance({ '10.0.0.5': { name: 'DeviceA' } })

		destroyDevice(self, '10.0.0.5')

		const line = at('warn').find((text) => text.includes('offline'))
		expect(line).toContain('DeviceA')
		expect(line).toContain('10.0.0.5')
		expect(line).toContain('3000ms')
		// the old wording leaked an implementation detail into an operator-facing line
		expect(line).not.toContain('Destroying references')
	})
})

describe('verbose diagnostics', () => {
	it('stay silent when verbose logging is off', () => {
		const self = instance({}, false)
		danteDiscovery(self, srvResponse('DeviceA'), { address: '10.0.0.5' } as never)

		expect(at('debug')).toEqual([])
	})

	it('keeps service ports out of the default log, being plumbing rather than network news', () => {
		const self = instance({}, false)
		danteDiscovery(self, srvResponse('DeviceA'), { address: '10.0.0.5' } as never)

		expect(at('info').filter((text) => text.includes('Port for service'))).toEqual([])
	})

	it('still reports service ports when verbose logging is on', () => {
		const self = instance({}, true)
		danteDiscovery(self, srvResponse('DeviceA'), { address: '10.0.0.5' } as never)

		expect(at('debug').some((text) => text.includes('Port for service ARC'))).toBe(true)
	})

	it('reports a device arriving at info either way, which is network news', () => {
		for (const verbose of [false, true]) {
			captured.length = 0
			const self = instance({}, verbose)
			danteDiscovery(self, srvResponse('DeviceA'), { address: '10.0.0.5' } as never)

			expect(
				at('info').some((text) => text.startsWith('Discovered DeviceA')),
				`verbose=${verbose}`,
			).toBe(true)
		}
	})

	it('report discovery detail when verbose logging is on', () => {
		const self = instance({}, true)
		danteDiscovery(self, srvResponse('DeviceA'), { address: '10.0.0.5' } as never)

		expect(at('debug').some((text) => text.includes('DeviceA'))).toBe(true)
	})
})

/**
 * A real receive-channel reply, so the route logging is exercised through the same parser the wire
 * uses rather than a stubbed shape. Layout per `parseRxChannels`: a 12-byte header, then one 20-byte
 * record per channel holding pointers into a string table appended after them.
 */
function rxReply(channels: { number: number; name: string; source?: string; channel?: string; status: number }[]) {
	const RECORD = 20
	const head = Buffer.alloc(12)
	const records = Buffer.alloc(RECORD * channels.length)
	const strings: Buffer[] = []
	let stringOffset = 12 + records.length

	/** Appends a string to the table and returns the pointer to it, or 0 for absent. */
	const intern = (value: string | undefined): number => {
		if (!value) return 0
		const at = stringOffset
		const buffer = Buffer.from(`${value}\0`, 'ascii')
		strings.push(buffer)
		stringOffset += buffer.length
		return at
	}

	channels.forEach((channel, index) => {
		const base = index * RECORD
		records.writeUInt16BE(channel.number, base + 0)
		records.writeUInt16BE(1, base + 4) // channel group, identical across records
		records.writeUInt16BE(intern(channel.channel), base + 6)
		records.writeUInt16BE(intern(channel.source), base + 8)
		records.writeUInt16BE(intern(channel.name), base + 10)
		records.writeUInt16BE(0, base + 12)
		records.writeUInt16BE(channel.status, base + 14)
	})

	const body = Buffer.concat([records, ...strings])
	head.writeUInt16BE(0x2729, 0)
	head.writeUInt16BE(12 + body.length, 2)
	head.writeUInt16BE(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY, 6)
	head.writeUInt8(channels.length, 11)
	return Buffer.concat([head, body])
}

describe('route changes', () => {
	const IP = '10.0.0.5'
	const rinfo = (reply: Buffer) => ({ address: IP, size: reply.length }) as never

	function deliver(self: DanteInstance, channels: Parameters<typeof rxReply>[0]) {
		const reply = rxReply(channels)
		parseReply(self, reply, rinfo(reply))
	}

	/** A device whose first receive page has already arrived, so the next one is a change. */
	function routed() {
		const self = instance({ [IP]: { name: 'DeviceA', ports: { ARC: 4440 } } })
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceB', channel: 'Out 1', status: 9 }])
		captured.length = 0
		return self
	}

	it('parses the reply this test builds, so the assertions below mean something', () => {
		const self = instance({ [IP]: { name: 'DeviceA', ports: { ARC: 4440 } } })
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceB', channel: 'Out 1', status: 9 }])

		expect(self.devicesData[IP].audioRx?.[1]).toMatchObject({
			name: 'In 1',
			sourceDevice: 'DeviceB',
			sourceChannel: 'Out 1',
		})
	})

	it('does not report the first sight of a route as a change', () => {
		const self = instance({ [IP]: { name: 'DeviceA', ports: { ARC: 4440 } } })
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceB', channel: 'Out 1', status: 9 }])

		expect(at('info').filter((text) => text.includes('Route'))).toEqual([])
	})

	it('reports a route moving to a different source, naming both', () => {
		const self = routed()
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceC', channel: 'Out 2', status: 9 }])

		const line = at('info').find((text) => text.startsWith('Route changed'))
		expect(line).toContain('DeviceA')
		expect(line).toContain('In 1')
		expect(line).toContain('DeviceC / Out 2')
		expect(line).toContain('DeviceB / Out 1')
	})

	it('reports a route being cleared', () => {
		const self = routed()
		deliver(self, [{ number: 1, name: 'In 1', status: 0 }])

		expect(at('info').find((text) => text.startsWith('Route changed'))).toContain('<- -')
	})

	it('reports a subscription that stops working without its source changing', () => {
		// the transmitter going offline flips the status while the names stay put
		const self = routed()
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceB', channel: 'Out 1', status: 1 }])

		const line = at('info').find((text) => text.startsWith('Route lost'))
		expect(line).toContain('DeviceA')
		expect(line).toContain('DeviceB / Out 1')
	})

	it('reports it recovering again', () => {
		const self = routed()
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceB', channel: 'Out 1', status: 1 }])
		captured.length = 0
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceB', channel: 'Out 1', status: 9 }])

		expect(at('info').find((text) => text.startsWith('Route restored'))).toContain('DeviceB / Out 1')
	})

	it('stays quiet when a re-poll returns the same routing', () => {
		const self = routed()
		deliver(self, [{ number: 1, name: 'In 1', source: 'DeviceB', channel: 'Out 1', status: 9 }])

		expect(at('info').filter((text) => text.includes('Route'))).toEqual([])
	})
})
