import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import { getChannelSubscriptionName } from './api.js'
import type DanteInstance from './main.js'

/** Builds and registers the set of variable definitions for all known devices. */
export function UpdateVariableDefinitions(self: DanteInstance): void {
	const variables: Record<string, CompanionVariableDefinition> = {
		devices: { name: 'Dante Devices' },
	}

	for (const device of Object.values(self.devicesData)) {
		if (!device.name) continue
		variables[device.name + '_ip'] = { name: 'Ip address of ' + device.name }
		variables[device.name + '_tx'] = { name: 'Number of outputs for ' + device.name }
		variables[device.name + '_tx_names'] = { name: 'Output names for ' + device.name }
		variables[device.name + '_rx'] = { name: 'Number of inputs for ' + device.name }
		variables[device.name + '_rx_names'] = { name: ' Input names for ' + device.name }
		variables[device.name + '_sr'] = { name: 'Sample rate of ' + device.name }
		variables[device.name + '_pullup'] = { name: 'Sample rate pullup of ' + device.name }
		variables[device.name + '_latency'] = { name: 'Latency of ' + device.name + ' (in ms)' }
		variables[device.name + '_encoding'] = { name: 'Encoding of ' + device.name }
		variables[device.name + '_output_levels'] = { name: 'Output levels of ' + device.name }
		variables[device.name + '_model_name'] = { name: 'Model name of ' + device.name }
		variables[device.name + '_product_version'] = { name: 'Product version of ' + device.name }
	}

	self.setVariableDefinitions(variables)
}

/**
 * Recomputes and pushes current variable values to Companion.
 * @param ipAddress If given, restricts the update to the device at this IP; otherwise all known devices are updated.
 * @param variableTypes Which variable categories to refresh; defaults to all categories if none are given.
 */
export function CheckVariables(self: DanteInstance, ipAddress?: string, ...variableTypes: string[]): void {
	const variableValues: CompanionVariableValues = { devices: [] }

	if (!(variableTypes.length > 0)) {
		variableTypes = ['ip', 'rx', 'tx', 'rx_names', 'tx_names', 'sr', 'latency', 'encoding', 'output_levels', 'manf']
	}

	const devices: string[] = []

	for (const [ip, device] of Object.entries(self.devicesData)) {
		const deviceName = device.name
		if (deviceName) {
			devices.push(deviceName)

			if (ip == ipAddress || !ipAddress) {
				for (const variableType of variableTypes) {
					switch (variableType) {
						case 'devices':
							break

						case 'ip':
							variableValues[deviceName + '_ip'] = ip
							break

						case 'rx':
						case 'tx':
							variableValues[deviceName + '_' + variableType] = device[variableType]?.count
							break

						case 'rx_names':
						case 'tx_names': {
							const channelType = variableType.slice(0, 2) as 'rx' | 'tx'
							const channelArray: string[] = []
							const ioObject = device[channelType]
							for (let i = 0; i < (ioObject?.count ?? 0); i++) {
								const channel = ioObject?.[i + 1]
								channelArray[i] = (channelType == 'tx' ? getChannelSubscriptionName(channel) : channel?.name) ?? ''
							}
							variableValues[deviceName + '_' + variableType] = channelArray
							break
						}

						case 'sr':
						case 'latency':
						case 'encoding':
						case 'pullup':
						case 'output_levels':
							variableValues[deviceName + '_' + variableType] = device[variableType]
							break

						case 'manf': {
							variableValues[deviceName + '_model_name'] = device.modelName
							const versionString = device.productVersionString
								? device.productVersionString
								: '' + device.productVersionMajor + '.' + device.productVersionMinor + '.' + device.productVersionPatch
							variableValues[deviceName + '_product_version'] = versionString
							break
						}
					}
				}
			}
		}
	}

	variableValues.devices = devices

	try {
		self.setVariableValues(variableValues)
	} catch (error) {
		self.log('error', 'Error setting variables: ' + error)
	}
}
