/**
 * mDNS discovery: finding Dante devices and the ports their services listen on.
 */

import { DANTE_CONST } from './const.js'
import { createModuleLogger } from '@companion-module/base'
import type dgram from 'node:dgram'
import type DanteInstance from '../main.js'
import type { MdnsResponsePacket, ServiceName } from './types.js'
import { keepAlive, registerDevice, scheduleUpdateData } from './devices.js'
import { updateDeviceChoice } from './choices.js'
import { getChannelCount, getSettings, getSettingsPort } from './queries.js'

const logger = createModuleLogger('api:discovery')

/**
 * Handles an mDNS response: follows up PTR records with SRV queries, and for SRV records
 * registers/updates the announcing device and its per-service port, kicking off follow-up
 * queries (channel count/settings for ARC, settings port for CMC) when a port is newly learned.
 */
export function danteDiscovery(self: DanteInstance, response: MdnsResponsePacket, rinfo: dgram.RemoteInfo): void {
	const answers = [...response.answers, ...response.additionals]
	answers.forEach((answer) => {
		const name = answer.name
		// get devices and services names and port
		if (answer.type == 'PTR' && DANTE_CONST.SERVICES_ARRAY.includes(name)) {
			if (self.debug) {
				logger.debug(`mDNS PTR from ${rinfo.address} : ${name} -> ${answer.data}, asking for its SRV record`)
			}
			self.mdns.query(
				{
					questions: [
						{
							name: answer.data,
							type: 'SRV',
						},
					],
				},
				(error) => {
					if (error) {
						logger.warn(`mDNS SRV query for ${answer.data} failed : ${error.message}`)
					}
				},
			)
		} else if (answer.type == 'SRV') {
			// register services and port
			for (const [id, danteService] of Object.entries(DANTE_CONST.SERVICES)) {
				const dotIndex = name.indexOf('.')
				const deviceName = name.slice(0, dotIndex)
				const serviceName = name.slice(dotIndex + 1)

				if (serviceName == danteService) {
					const deviceIp = rinfo.address
					if (self.debug) {
						logger.debug(`mDNS SRV from ${deviceIp} : ${deviceName} offers ${id} on port ${answer.data.port}`)
					}
					let currDevice = self.devicesData[deviceIp]

					if (currDevice) {
						keepAlive(self, deviceIp)
					} else {
						// create data object if needed
						currDevice = registerDevice(self, deviceIp, deviceName)
						scheduleUpdateData(self)
					}

					if (currDevice.name != deviceName) {
						// updateDeviceChoice reads the outgoing name off the device record to find the choice
						// it must replace, so the record has to still hold it. Assigning first left the old
						// entry in `devicesChoices` alongside the new one.
						updateDeviceChoice(self, deviceIp, deviceName)
						currDevice.name = deviceName
						scheduleUpdateData(self)
					}
					if (!currDevice.ports) {
						currDevice.ports = {}
					}

					const serviceId = id as ServiceName
					if (currDevice.ports[serviceId] != answer.data.port) {
						// which port a service landed on is protocol plumbing, not something an operator acts on
						if (self.debug) {
							logger.debug(`Port for service ${serviceId} of device ${deviceName} is : ${answer.data.port}`)
						}
						currDevice.ports[serviceId] = answer.data.port

						switch (serviceId) {
							case 'ARC':
								getChannelCount(self, deviceIp)
								getSettings(self, deviceIp)
								break

							case 'CMC':
								getSettingsPort(self, deviceIp)
								break
						}
					}
				}
			}
		}
	})
}

/** Sends an mDNS query for all Dante service types, to discover devices on the network. */
export function getMdnsServices(self: DanteInstance): void {
	if (self.debug) {
		logger.debug(
			`mDNS discovery sweep: asking for ${DANTE_CONST.SERVICES_ARRAY.length} Dante service types` +
				` (${Object.keys(self.devicesData).length} device(s) currently known)`,
		)
	}

	const questions = DANTE_CONST.SERVICES_ARRAY.map((service) => ({
		name: service,
		type: 'PTR' as const,
	}))

	self.mdns?.query(
		{
			questions: questions,
		},
		(error) => {
			if (error) {
				logger.warn(`mDNS discovery query failed : ${error.message}`)
			}
		},
	)
}
