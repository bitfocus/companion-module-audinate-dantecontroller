import {
	InstanceBase,
	InstanceStatus,
	type DropdownChoice,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import type multidns from 'multicast-dns'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { initConnection, destroyDevice, type DevicesData, type DanteSockets, type ConnectionName } from './api.js'
import type { DanteModuleTypes } from './types.js'

export { UpgradeScripts }

/**
 * Companion instance class for the Audinate Dante controller module.
 *
 * This class only holds instance state and the Companion lifecycle hooks. All of its
 * behavior (actions, feedbacks, variables, presets, and the Dante network/protocol API)
 * lives in plain functions in the other module files, which take this instance as an
 * explicit `self` parameter rather than being mixed onto the class.
 */
export default class DanteInstance extends InstanceBase<DanteModuleTypes> {
	config!: ModuleConfig

	devicesData: DevicesData = {}
	sockets: DanteSockets = {}
	devicesChoices: DropdownChoice[] = []
	txChannelsChoices: Record<string, DropdownChoice[]> = {}
	rxChannelsChoices: Record<string, DropdownChoice[]> = {}
	txFriendlyNameRefreshCounter = 0

	counter: Buffer = Buffer.alloc(2)
	mac: Buffer = Buffer.alloc(6)
	debug = false
	timeout = 0
	activeConnections: Partial<Record<ConnectionName, boolean>> = {}
	CONNECTED = false
	INTERVAL: NodeJS.Timeout | null = null
	mdns!: multidns.MulticastDNS

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		// Fire-and-forget, matching the original behaviour - init doesn't wait for the
		// connection/discovery cycle kicked off by configUpdated to complete.
		void this.configUpdated(config)
	}

	async destroy(): Promise<void> {
		if (this.INTERVAL) {
			clearInterval(this.INTERVAL)
			this.INTERVAL = null
		}
		for (const ip of Object.keys(this.devicesData)) {
			destroyDevice(this, ip)
		}

		for (const socket of Object.values(this.sockets)) {
			try {
				socket?.close()
			} catch {
				// already closed - nothing to do on teardown
			}
		}
		this.sockets = {}

		if (this.mdns) {
			this.mdns.removeAllListeners()
			this.mdns.destroy()
		}
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config

		if (this.config.verbose) {
			this.log('info', 'Verbose mode enabled. Log entries will contain detailed information.')
		}

		this.updateStatus(InstanceStatus.Connecting)

		initConnection(this)
		UpdateActions(this)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}
}
