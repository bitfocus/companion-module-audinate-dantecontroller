import type { ModuleConfig } from './config.js'
import type { ActionSchema } from './actions.js'
import type { FeedbackSchema } from './feedbacks.js'

/**
 * The per-device variables this module exposes, as suffix -> value type.
 *
 * Each entry becomes a `<deviceName>_<suffix>` variable. Keeping the suffixes in one place lets
 * the variable schema, the definitions in `UpdateVariableDefinitions`, and the values written by
 * `CheckVariables` all be checked against the same source of truth.
 */
export interface DanteDeviceVariables {
	/** IP address the device was discovered at. */
	ip: string
	/** Number of receive (input) channels. */
	rx: number
	/** Number of transmit (output) channels. */
	tx: number
	/** Receive channel names, indexed by channel number - 1. */
	rx_names: string[]
	/** Transmit channel names, indexed by channel number - 1. */
	tx_names: string[]
	/** Number of video receive (input) channels. */
	rx_video: number
	/** Number of video transmit (output) channels. */
	tx_video: number
	/** Video receive channel names, indexed by channel number - 1. */
	rx_names_video: string[]
	/** Video transmit channel names, indexed by channel number - 1. */
	tx_names_video: string[]
	/** True when the device is locked and refusing configuration changes. */
	locked: boolean
	/** Sample rate in Hz. */
	sr: number
	/** Latency in milliseconds. */
	latency: number
	/** Sample rate pullup, as a percentage string. */
	pullup: string
	/** Encoding, either a bit depth or a named encoding. */
	encoding: string | number
	/** Per-channel output levels, either a named level or a raw value. */
	output_levels: (string | number)[]
	model_name: string
	product_version: string
	/** Dante model identifier, as distinct from the manufacturer's model name. */
	dante_model: string
	/** Dante software version, as `major.minor.patch`. */
	dante_software_version: string
	/** Hardware version, as `major.minor.patch`. */
	hardware_version: string
	manufacturer: string
	/** Short form of the manufacturer name, as the device reports it. */
	manufacturer_short: string
	/** Manufacturer software version, as `major.minor.patch`. */
	software_version: string
	/** Build numbers, exposed separately so they can be formatted however a layout needs. */
	software_build: number
	dante_software_build: number
	hardware_build: number
}

/** A `<deviceName>_<suffix>` variable id for one of the {@link DanteDeviceVariables} suffixes. */
export type DanteDeviceVariableId = `${string}_${keyof DanteDeviceVariables & string}`

/**
 * The variables this module publishes.
 *
 * Device names are only known at runtime, so the per-device entries are template-literal index
 * signatures rather than concrete keys: the device half stays open while the suffix and its value
 * type are both pinned. That is enough for TypeScript to reject an unknown suffix and to catch a
 * value written at the wrong type - `setVariableValues({ [`${name}_rx`]: 'sixteen' })` no longer
 * compiles, and `getVariableValue(`${name}_sr`)` is typed `number | undefined` instead of `any`.
 *
 * Note that values must be built by assignment rather than as one object literal: TypeScript
 * widens computed keys in a literal to `string`, which does not match any of these signatures.
 */
export type DanteVariableValues = {
	/** Names of all currently discovered devices. */
	devices: string[]
} & {
	[Suffix in keyof DanteDeviceVariables as `${string}_${Suffix & string}`]: DanteDeviceVariables[Suffix] | undefined
}

export interface DanteModuleTypes {
	config: ModuleConfig
	secrets: undefined
	actions: ActionSchema
	feedbacks: FeedbackSchema
	variables: DanteVariableValues
}
