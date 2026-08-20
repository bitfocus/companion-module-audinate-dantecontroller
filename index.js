import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import UpgradeScripts from './src/upgrades.js'

import config from './src/config.js'
import actions from './src/actions.js'
import feedbacks from './src/feedbacks.js'
import variables from './src/variables.js'
import presets from './src/presets.js'
import api from './src/api.js'

class danteInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		// Assign the methods from the listed files to this class
		Object.assign(this, {
			...config,
			...actions,
			...feedbacks,
			...variables,
			...presets,
			...api,
		})

		this.INTERVAL = null //used to poll the clock every second
		this.CONNECTED = false //used for friendly notifying of the user that we have not received data yet

		this.devicesData = {}
	}

	async destroy() {
		let self = this

		if (self.INTERVAL) {
			clearInterval(self.INTERVAL)
			self.INTERVAL = null
		}
		for (const ip of Object.keys(self.devicesData)) {
			this.destroyDevice(ip)
		}

		for (const socket of Object.values(self.sockets)) {
			socket.close()
		}
	}

	async init(config) {
		this.configUpdated(config) //.catch((error) => {
		//			this.log('error', 'Error initiating the module');
		//		})
	}

	async configUpdated(config) {
		this.config = config

		if (this.config.verbose) {
			this.log('info', 'Verbose mode enabled. Log entries will contain detailed information.')
		}

		this.updateStatus(InstanceStatus.Connecting)

		this.initConnection()
		this.initActions()
	}
}

runEntrypoint(danteInstance, UpgradeScripts)
