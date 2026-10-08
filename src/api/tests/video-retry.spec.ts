import { describe, expect, it, vi } from 'vitest'
import { retryMissingVideoDirectories, type DevicesData } from '../index.js'
import type DanteInstance from '../../main.js'

/**
 * Re-asking for a video directory that never arrived.
 *
 * The video queries are one-shot - sent when a device's ARC port is first learned, on a
 * channel-change notification, after one of this module's own writes, and on Refresh. A single
 * dropped reply therefore left the directory permanently unknown, and the crosspoint feedbacks read
 * the transmit directory to resolve a selected channel's name, so they silently read false until
 * somebody pressed Refresh. The receive side self-heals on the next route change; the transmit side
 * is re-read only on a rename, which may never happen.
 */

const IP = '172.16.3.141'

function instance(device: Record<string, unknown>): { self: DanteInstance; sent: Buffer[] } {
	const sent: Buffer[] = []
	const self = {
		devicesData: { [IP]: device } as unknown as DevicesData,
		debug: false,
		counter: Buffer.alloc(2),
		mac: Buffer.alloc(6),
		sockets: { ARC: { send: vi.fn((buffer: Buffer) => sent.push(Buffer.from(buffer))) } },
		log: vi.fn(),
	} as unknown as DanteInstance
	return { self, sent }
}

/** How many directory queries a run issued. */
function sweep(self: DanteInstance, sent: Buffer[], times = 1): number {
	const before = sent.length
	for (let i = 0; i < times; i++) retryMissingVideoDirectories(self)
	return sent.length - before
}

describe('retryMissingVideoDirectories', () => {
	it('re-asks a device that has answered neither directory', () => {
		const { self, sent } = instance({ name: 'Encoder', ports: { ARC: 4440 } })
		expect(sweep(self, sent)).toBe(2)
	})

	it('leaves alone a device that answered, even reporting no video channels', () => {
		// a device that does not speak AV_EXTENDED answers with an unrecognised-command reply, which
		// parses as zero channels - so the field is set and there is nothing to chase
		const { self, sent } = instance({
			name: 'AudioOnly',
			ports: { ARC: 4440 },
			videoRx: { count: 0 },
			videoTx: { count: 0 },
		})
		expect(sweep(self, sent, 10)).toBe(0)
	})

	it('chases only the direction that is missing', () => {
		const { self, sent } = instance({ name: 'Encoder', ports: { ARC: 4440 }, videoRx: { count: 1 } })
		expect(sweep(self, sent)).toBe(1)
	})

	it('gives up after a bounded number of attempts', () => {
		const { self, sent } = instance({ name: 'Encoder', ports: { ARC: 4440 } })
		// two directions x five attempts, and nothing after that however long the connection runs
		expect(sweep(self, sent, 50)).toBe(10)
	})

	it('stops as soon as the directory arrives', () => {
		const { self, sent } = instance({ name: 'Encoder', ports: { ARC: 4440 } })
		sweep(self, sent)

		const device = self.devicesData[IP] as Record<string, unknown>
		device.videoRx = { count: 1 }
		device.videoTx = { count: 1 }
		expect(sweep(self, sent, 10)).toBe(0)
	})

	it('waits until discovery has learned where to send the query', () => {
		const { self, sent } = instance({ name: 'Encoder', ports: {} })
		expect(sweep(self, sent, 5)).toBe(0)
	})

	it('gives a device that goes away and returns a fresh budget', () => {
		const { self, sent } = instance({ name: 'Encoder', ports: { ARC: 4440 } })
		sweep(self, sent, 50)
		expect(sweep(self, sent)).toBe(0)

		// the device times out, and a sweep while it is gone releases what it spent
		const device = self.devicesData[IP]
		delete self.devicesData[IP]
		sweep(self, sent)
		self.devicesData[IP] = device

		expect(sweep(self, sent)).toBe(2)
	})
})
