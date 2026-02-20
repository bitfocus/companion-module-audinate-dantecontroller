const { InstanceBase, InstanceStatus, Regex, runEntrypoint } = require('@companion-module/base')
const UpgradeScripts = require('./src/upgrades')

const config = require('./src/config')
const actions = require('./src/actions')
const feedbacks = require('./src/feedbacks')
const variables = require('./src/variables')
const presets = require('./src/presets')

const api = require('./src/api')

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
			...api
		})


		this.INTERVAL = null; //used to poll the clock every second
		this.CONNECTED = false; //used for friendly notifying of the user that we have not received data yet

		this.devicesData = {};
	}

	async destroy() {
		let self = this;

		if (self.INTERVAL) {
			clearInterval(self.INTERVAL);
			self.INTERVAL = null;
		}
		for (const ip of Object.keys(self.devicesData)) {
			this.destroyDevice(ip);
		}
	}

	async init(config) {
		this.configUpdated(config)
	}

	async configUpdated(config) {
		this.config = config

		if (this.config.verbose) {
			this.log('info', 'Verbose mode enabled. Log entries will contain detailed information.');
		}
	
		this.updateStatus(InstanceStatus.Connecting);

		this.initConnection();
	}
}

runEntrypoint(danteInstance, UpgradeScripts);