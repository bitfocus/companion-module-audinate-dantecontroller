import type dgram from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import { DANTE_CONST, makeAudioCrosspointConfirmed, notifyRxStateChanged, type DevicesData } from '../api/index.js'
import type DanteInstance from '../main.js'
import { answeringSend } from './fake-device.js'
import { ch, ip, name } from './ids.js'

/**
 * Behaviour pinned to a real capture: Dante Controller routing two Ultimo X2 boards (IMAG-IO1 at
 * .237, IMAG-IO2 at .238), audio only.
 */

const IO1 = ip('192.168.1.237')
const IO2 = ip('192.168.1.238')

function instance(data: DevicesData = {}) {
	return {
		config: { mac: '', interval: 1000, timeoutInterval: 3000, variables: false, verbose: false },
		devicesData: data,
		devicesChoices: [],
		rxChannelsChoices: {},
		txChannelsChoices: {},
		videoRxChannelsChoices: {},
		videoTxChannelsChoices: {},
		counter: Buffer.from('0100', 'hex'),
		debug: false,
		timeout: 0,
		mdns: { query: vi.fn() },
		setActionDefinitions: vi.fn(),
		setFeedbackDefinitions: vi.fn(),
		setVariableDefinitions: vi.fn(),
		setVariableValues: vi.fn(),
		checkFeedbacksById: vi.fn(),
		log: vi.fn(),
	} as unknown as DanteInstance
}

describe('capture dante4: confirming a route that needs a new flow', () => {
	it('waits through the connecting status the device reports while the flow comes up', async () => {
		const self = instance({
			[IO1]: {
				name: name('IMAG-IO1'),
				ports: { ARC: 4440 },
				audioRx: {
					count: 2,
					1: { number: ch(1), name: '01 IMAG-MIX-XLR-L' },
					2: { number: ch(2), name: '02 IMAG-MIX-XLR-R' },
				},
			},
			[IO2]: {
				name: name('IMAG-IO2'),
				ports: { ARC: 4440 },
				audioTx: {
					count: 2,
					1: { number: ch(1), name: '01 IMAG-LTC-XLR-LOCALBACKUP' },
					2: { number: ch(2), name: '02 n/a' },
				},
			},
		})
		// As captured: subscribed at once with status 0x0001 and receiver status 0, then connected
		// (0x0009) about 150 ms later, which the device announces with a second notification pair.
		const send = answeringSend(self, (command) =>
			command.readUInt16BE(6) === DANTE_CONST.COMMANDS.subscription
				? {
						apply: () => {
							const subscribed = {
								number: ch(2),
								name: '02 IMAG-MIX-XLR-R',
								sourceDevice: 'IMAG-IO2',
								sourceChannel: '02 n/a',
							}
							self.devicesData[IO1].audioRx![2] = { ...subscribed, subscriptionStatus: 0x0001, channelStatus: 0x0000 }
							setTimeout(() => {
								self.devicesData[IO1].audioRx![2] = { ...subscribed, subscriptionStatus: 0x0009, channelStatus: 0x0101 }
								notifyRxStateChanged(self, IO1)
							}, 150)
						},
					}
				: undefined,
		)
		self.sockets = { ARC: { send } as unknown as dgram.Socket }

		const started = Date.now()
		await makeAudioCrosspointConfirmed(self, 'IMAG-IO1', '02 n/a', 'IMAG-IO2', 2)

		// resolved on the notification, not a later poll
		expect(Date.now() - started).toBeLessThan(400)
	})
})
