import {
	InstanceBase,
	InstanceStatus,
	type DropdownChoice,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import type multidns from 'multicast-dns'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpgradeScripts } from './upgrades.js'
import {
	DanteConnection,
	cancelCheckFeedbacks,
	initConnection,
	destroyDevice,
	cancelUpdateData,
	scheduleUpdateData,
	cancelCheckVariables,
	type DevicesData,
	type DanteSockets,
	type ConnectionName,
} from './api/index.js'
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
	/** Discovered devices, keyed by name - see `resolveDeviceIp`. */
	devicesChoices: DropdownChoice<string>[] = []
	txChannelsChoices: Record<string, DropdownChoice<number>[]> = {}
	rxChannelsChoices: Record<string, DropdownChoice<number>[]> = {}
	txFriendlyNameRefreshCounter = 0

	debug = false
	timeout = 0

	/**
	 * The network connection: sockets, discovery, and the state saying whether they are usable.
	 *
	 * The accessors below forward to it so the rest of the module keeps reading `self.sockets`,
	 * `self.counter` and so on - the state lives in one place, without every call site having to
	 * spell out the indirection.
	 */
	readonly connection: DanteConnection = new DanteConnection(this)

	get sockets(): DanteSockets {
		return this.connection.sockets
	}
	set sockets(value: DanteSockets) {
		this.connection.sockets = value
	}
	get mdns(): multidns.MulticastDNS {
		// only read after initConnection has created it
		return this.connection.mdns as multidns.MulticastDNS
	}
	set mdns(value: multidns.MulticastDNS) {
		this.connection.mdns = value
	}
	get counter(): Buffer {
		return this.connection.counter
	}
	set counter(value: Buffer) {
		this.connection.counter = value
	}
	get mac(): Buffer {
		return this.connection.mac
	}
	set mac(value: Buffer) {
		this.connection.mac = value
	}
	get activeConnections(): Partial<Record<ConnectionName, boolean>> {
		return this.connection.activeConnections
	}
	set activeConnections(value: Partial<Record<ConnectionName, boolean>>) {
		this.connection.activeConnections = value
	}
	get configError(): string | null {
		return this.connection.configError
	}
	set configError(value: string | null) {
		this.connection.configError = value
	}
	get CONNECTED(): boolean {
		return this.connection.connected
	}
	set CONNECTED(value: boolean) {
		this.connection.connected = value
	}
	get INTERVAL(): NodeJS.Timeout | null {
		return this.connection.interval
	}
	set INTERVAL(value: NodeJS.Timeout | null) {
		this.connection.interval = value
	}

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.configUpdated(config).catch((error: unknown) => {
			this.log('error', `Initialisation failed : ${error instanceof Error ? error.message : String(error)}`)
			this.updateStatus(InstanceStatus.UnknownError)
		})
	}

	async destroy(): Promise<void> {
		for (const ip of Object.keys(this.devicesData)) {
			destroyDevice(this, ip)
		}
		// destroyDevice queues a rebuild per device; none of them should reach a torn-down instance
		cancelUpdateData(this)
		cancelCheckVariables(this)
		cancelCheckFeedbacks(this)

		this.connection.close()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config

		if (this.config.verbose) {
			this.log('info', 'Verbose mode enabled. Log entries will contain detailed information.')
		}

		this.updateStatus(InstanceStatus.Connecting)

		initConnection(this)
		// Every other rebuild is triggered by a device appearing, changing or going away, so on a
		// network with no Dante devices this is the only one that ever runs. It has to register
		// feedbacks and variables as well as actions, or a connection that finds nothing offers
		// nothing - not even the global device-names variable.
		//
		// Scheduled rather than run here: discovery usually finds its first devices inside the
		// debounce window, so the two collapse into one rebuild carrying real data instead of an
		// empty one immediately followed by the real one. It also means a re-config leaves the
		// previous definitions in place for that window rather than blanking every dropdown first.
		// `initConnection` has just cancelled anything the outgoing generation had pending.
		scheduleUpdateData(this)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}
}
