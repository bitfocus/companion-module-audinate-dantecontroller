import { describe, expect, it, vi } from 'vitest'
import { danteDiscovery } from '../discovery.js'
import { DANTE_CONST } from '../const.js'
import type DanteInstance from '../../main.js'

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

function instance(): DanteInstance {
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
		log: vi.fn(),
		updateStatus: vi.fn(),
	} as unknown as DanteInstance
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

	it('does not re-query video channels on a keep-alive that does not change the ARC port', () => {
		const self = instance()
		const rinfo = { address: '10.0.0.5' } as never

		danteDiscovery(self, srvResponse('Decoder-001'), rinfo)
		;(self.sockets.ARC!.send as ReturnType<typeof vi.fn>).mockClear()

		danteDiscovery(self, srvResponse('Decoder-001'), rinfo)

		expect(self.sockets.ARC!.send).not.toHaveBeenCalled()
	})
})
