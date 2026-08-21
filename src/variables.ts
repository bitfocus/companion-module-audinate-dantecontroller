import { createModuleLogger, type CompanionVariableDefinitions } from '@companion-module/base'
import { deviceProperty } from './api/index.js'
import type { DanteVariableValues } from './types.js'
import type DanteInstance from './main.js'

const logger = createModuleLogger('variables')

/** Builds and registers the set of variable definitions for all known devices. */
export function UpdateVariableDefinitions(self: DanteInstance): void {
	if (!self.config.variables) {
		// Publish an empty set rather than simply returning, so turning the option off actually
		// removes variables a previous run created. The schema makes `devices` a required key, which
		// is why expressing "no variables at all" needs the cast.
		self.setVariableDefinitions({} as CompanionVariableDefinitions<DanteVariableValues>)
		return
	}

	const variables: CompanionVariableDefinitions<DanteVariableValues> = {
		devices: { name: 'Dante Devices' },
	}

	for (const device of Object.values(self.devicesData)) {
		if (!device.name) continue
		variables[`${device.name}_ip`] = { name: 'Ip address of ' + device.name }
		variables[`${device.name}_locked`] = { name: 'Device lock state of ' + device.name }
		variables[`${device.name}_tx`] = { name: 'Number of outputs for ' + device.name }
		variables[`${device.name}_tx_names`] = { name: 'Output names for ' + device.name }
		variables[`${device.name}_rx`] = { name: 'Number of inputs for ' + device.name }
		variables[`${device.name}_rx_names`] = { name: ' Input names for ' + device.name }
		variables[`${device.name}_sr`] = { name: 'Sample rate of ' + device.name }
		variables[`${device.name}_pullup`] = { name: 'Sample rate pullup of ' + device.name }
		variables[`${device.name}_latency`] = { name: 'Latency of ' + device.name + ' (in ms)' }
		variables[`${device.name}_encoding`] = { name: 'Encoding of ' + device.name }
		variables[`${device.name}_output_levels`] = { name: 'Output levels of ' + device.name }
		variables[`${device.name}_model_name`] = { name: 'Model name of ' + device.name }
		variables[`${device.name}_product_version`] = { name: 'Product version of ' + device.name }
	}

	self.setVariableDefinitions(variables)
}

/**
 * Every variable category `CheckVariables` knows how to refresh, used when no explicit set is given.
 *
 * `pullup` was missing here despite having both a definition and a case below, so a full sweep
 * never refreshed `<device>_pullup` - it only ever updated when a settings reply happened to pass
 * 'pullup' explicitly.
 */
export const ALL_VARIABLE_TYPES = [
	'ip',
	'locked',
	'rx',
	'tx',
	'rx_names',
	'tx_names',
	'sr',
	'latency',
	'encoding',
	'pullup',
	'output_levels',
	'manf',
] as const

/**
 * Recomputes and pushes current variable values to Companion.
 * @param ipAddress If given, restricts the update to the device at this IP; otherwise all known devices are updated.
 * @param variableTypes Which variable categories to refresh; defaults to all categories if none are given.
 */
export function CheckVariables(self: DanteInstance, ipAddress?: string, ...variableTypes: string[]): void {
	// Device properties are still tracked; they are just not published as variables. The Device
	// Property feedback reads them through the same accessor either way.
	if (!self.config.variables) return

	const variableValues: Partial<DanteVariableValues> = { devices: [] }

	if (!(variableTypes.length > 0)) {
		variableTypes = [...ALL_VARIABLE_TYPES]
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

						// Values come from `deviceProperty`, the same accessor the Device Property feedback
						// reads, so a variable and a feedback can never disagree about a device.
						case 'ip':
							variableValues[`${deviceName}_ip`] = deviceProperty(device, ip, 'ip')
							break

						case 'locked':
							variableValues[`${deviceName}_locked`] = deviceProperty(device, ip, 'locked')
							break

						case 'rx':
						case 'tx':
							variableValues[`${deviceName}_${variableType}`] = deviceProperty(device, ip, variableType)
							break

						case 'rx_names':
						case 'tx_names':
							variableValues[`${deviceName}_${variableType}`] = deviceProperty(device, ip, variableType)
							break

						// Split rather than grouped: each of these has its own value type in the schema, so a
						// single indexed write would be checked against the union of them all.
						case 'sr':
							variableValues[`${deviceName}_sr`] = deviceProperty(device, ip, 'sr')
							break

						case 'latency':
							variableValues[`${deviceName}_latency`] = deviceProperty(device, ip, 'latency')
							break

						case 'encoding':
							variableValues[`${deviceName}_encoding`] = deviceProperty(device, ip, 'encoding')
							break

						case 'pullup':
							variableValues[`${deviceName}_pullup`] = deviceProperty(device, ip, 'pullup')
							break

						case 'output_levels':
							variableValues[`${deviceName}_output_levels`] = deviceProperty(device, ip, 'output_levels')
							break

						// one update category, two variables
						case 'manf':
							variableValues[`${deviceName}_model_name`] = deviceProperty(device, ip, 'model_name')
							variableValues[`${deviceName}_product_version`] = deviceProperty(device, ip, 'product_version')
							break
					}
				}
			}
		}
	}

	variableValues.devices = devices

	try {
		self.setVariableValues(variableValues)
	} catch (error) {
		logger.error('Error setting variables: ' + error)
	}
}
