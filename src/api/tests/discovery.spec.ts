import { describe, expect, it, vi } from 'vitest'
import { danteDiscovery } from '../discovery.js'
import { DANTE_CONST } from '../const.js'
import type DanteInstance from '../../main.js'
import type { NetworkInterfaceInfo } from '../../config.js'

/**
 * An mDNS SRV response is how a device's ARC port is first (or newly) learned - see
 * `danteDiscovery` in `discovery.ts`. Real hardware sends one PTR-then-SRV round trip per service
 * per device; only the SRV half matters here, since that is what triggers the follow-up queries.
 */
function srvResponse(deviceName: string, service: 'netaudio-arc' | 'netaudio-cmc' = 'netaudio-arc', port = 4440) {
	return {
		answers: [{ type: 'SRV' as const, name: `${deviceName}._${service}._udp.local`, data: { port } }],
		additionals: [],
	}
}

function instance(boundInterface?: NetworkInterfaceInfo): DanteInstance {
	return {
		devicesData: {},
		devicesChoices: [],
		counter: Buffer.from('0000', 'hex'),
		mac: Buffer.from('aabbccddeeff', 'hex'),
		sockets: { ARC: { send: vi.fn() } },
		mdns: { query: vi.fn() },
		debug: false,
		timeout: 3000,
		config: { mac: 'x', interval: 1000, timeoutInterval: 3000, variables: true, verbose: false },
		boundInterface,
		ignoredSources: new Set<string>(),
		log: vi.fn(),
		updateStatus: vi.fn(),
	} as unknown as DanteInstance
}

/** The card the operator chose, on a host that also has a second one carrying Dante traffic. */
const chosenCard: NetworkInterfaceInfo = {
	name: 'ens160',
	address: '172.16.0.17',
	mac: '00:0c:29:1a:2b:3c',
	netmask: '255.255.255.0',
}

/** Reads the message-type id (offset 6) out of a sent command buffer. */
function messageType(buffer: Buffer): number {
	return buffer.readUInt16BE(6)
}

/** True for a buffer built under `AV_EXTENDED`, as opposed to the legacy `CONTROL` protocol. */
function isAvExtended(buffer: Buffer): boolean {
	return (
		(buffer.readUInt16BE(0) & DANTE_CONST.AV_EXTENDED_MASK) ===
		(DANTE_CONST.PROTOCOL.AV_EXTENDED & DANTE_CONST.AV_EXTENDED_MASK)
	)
}

describe('danteDiscovery', () => {
	it('queries video channels alongside channel count and settings when ARC is newly discovered', () => {
		// Without this, a device's video routes/names stay unknown - and any per-device video option
		// field, which only appears once channels are known - never shows up until someone manually
		// runs the Refresh action.
		const self = instance()
		const rinfo = { address: '10.0.0.5' } as never

		danteDiscovery(self, srvResponse('Decoder-001'), rinfo)

		const sent = (self.sockets.ARC!.send as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as Buffer)
		const avMessageTypes = sent.filter(isAvExtended).map(messageType)

		expect(avMessageTypes).toContain(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_RX_CHANNEL_QUERY)
		expect(avMessageTypes).toContain(DANTE_CONST.COMMANDS.MESSAGE_TYPE_AV_TX_CHANNEL_QUERY)

		const controlMessageTypes = sent.filter((buffer) => !isAvExtended(buffer)).map(messageType)
		expect(controlMessageTypes).toContain(DANTE_CONST.COMMANDS.channelCount)
		expect(controlMessageTypes).toContain(DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_QUERY)
	})

	// A wildcard-bound mDNS socket receives announcements that arrived on every card, not just the
	// chosen one - so on a multi-homed host (a VM with two vNICs) devices on the other network would
	// otherwise be registered and controlled despite the operator having picked a card.
	it('ignores a device announcing from outside the chosen card subnet', () => {
		const self = instance(chosenCard)

		danteDiscovery(self, srvResponse('Other-Network-Device'), { address: '172.16.3.99' } as never)

		expect(self.devicesData).toEqual({})
		expect(self.devicesChoices).toEqual([])
		expect(self.sockets.ARC!.send).not.toHaveBeenCalled()
	})

	it('does not follow up a PTR record from outside the chosen card subnet', () => {
		const self = instance(chosenCard)
		const ptr = {
			answers: [{ type: 'PTR' as const, name: DANTE_CONST.SERVICES_ARRAY[0], data: 'Other._netaudio-arc._udp.local' }],
			additionals: [],
		}

		danteDiscovery(self, ptr, { address: '172.16.3.99' } as never)

		expect(self.mdns.query).not.toHaveBeenCalled()
	})

	it('discovers a device on the chosen card subnet', () => {
		const self = instance(chosenCard)

		danteDiscovery(self, srvResponse('On-Network-Device'), { address: '172.16.0.42' } as never)

		expect(self.devicesData['172.16.0.42']?.name).toBe('On-Network-Device')
	})

	it('accepts every device when the card is chosen automatically', () => {
		// No explicit choice means no scope to enforce - the module is meant to find everything.
		const self = instance(undefined)

		danteDiscovery(self, srvResponse('First'), { address: '172.16.0.42' } as never)
		danteDiscovery(self, srvResponse('Second'), { address: '172.16.3.99' } as never)

		expect(Object.keys(self.devicesData).sort()).toEqual(['172.16.0.42', '172.16.3.99'])
	})

	it('does not re-query video channels on a keep-alive that does not change the ARC port', () => {
		const self = instance()
		const rinfo = { address: '10.0.0.5' } as never

		danteDiscovery(self, srvResponse('Decoder-001'), rinfo)
		;(self.sockets.ARC!.send as ReturnType<typeof vi.fn>).mockClear()

		danteDiscovery(self, srvResponse('Decoder-001'), rinfo)

		expect(self.sockets.ARC!.send).not.toHaveBeenCalled()
	})
})
