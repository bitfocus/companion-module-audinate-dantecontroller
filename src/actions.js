const {DANTE_CONST, object2choices, object2PartialChoices, array2choices} = require("./const");

module.exports = {
	initActions: function () {
		let self = this;
		let actions = {};
			
		

		actions.makeCrosspoint = {
			name: 'Make Crosspoint',
			options: [
				{
					type: 'textinput',
					label: 'Source Channel Name',
					id: 'sourceChannelName',
					default: 'Input 1',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Source Device Name',
					id: 'sourceDeviceName',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Channel',
					tooltip: 'Enter either channel name or channel number',
					id: 'destinationChannelNumber',
					default: '1',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Device',
					tooltip: 'Enter either device name or device IP',
					id: 'destinationDeviceAddress',
					default: 'MyDanteDevice',
					useVariables: true
				},
			],
			callback: async function (action, context) {
				const opt = action.options;
				const sourceChannelName = await context.parseVariablesInString(opt.sourceChannelName);
				const sourceDeviceName = await context.parseVariablesInString(opt.sourceDeviceName);
				const destinationChannel = await context.parseVariablesInString(opt.destinationChannelNumber);
				const destinationDevice = await context.parseVariablesInString(opt.destinationDeviceAddress);
				
				self.makeCrosspoint(destinationDevice, sourceChannelName, sourceDeviceName, destinationChannel)
			}
		}
		
		
		
		actions.makeCrosspointDropDown = {
			name: 'Make Crosspoint (drop down menu)',
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: self.devicesChoices
				}
			],
			callback: async function (action) {
				let opt = action.options;
				const sourceChannelNumber = opt['sourceChannel_'+opt.sourceDevice];
				const sourceChannel = self.devicesData[opt.sourceDevice]?.tx?.[sourceChannelNumber] || self.findTxChannelByName(opt.sourceDevice, sourceChannelNumber);
				const sourceChannelName = self.getChannelSubscriptionName(sourceChannel) || sourceChannelNumber;
				self.makeCrosspoint(opt.destinationDevice, sourceChannelName, self.devicesData[opt.sourceDevice]?.name, opt['destinationChannel_'+opt.destinationDevice]);
			}
		}

		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'Destination channel',
				id: 'destinationChannel_'+ ip,
				choices: this.rxChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return (options.destinationDevice == deviceIp);}
			}
			actions.makeCrosspointDropDown.options.push(nameOption);
		}

		
		actions.makeCrosspointDropDown.options.push({
					type: 'dropdown',
					label: 'Source Device',
					id: 'sourceDevice',
					choices: this.devicesChoices
				})
	
		
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'Source channel',
				id: 'sourceChannel_'+ ip,
				choices: this.txChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return (options.sourceDevice == deviceIp);}
			}
			actions.makeCrosspointDropDown.options.push(nameOption);
		}
		

		actions.clearCrosspoint = {
			name: 'Clear Crosspoint',
			options: [
				{
					type: 'textinput',
					label: 'Destination Channel',
					tooltip: 'Enter either channer name or channel number',
					id: 'destinationChannelNumber',
					default: '1',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Device',
					tooltip: 'Enter either device name or device IP',
					id: 'destinationDeviceAdddress',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
			],
			callback: async function (action, context) {
				const opt = action.options;
				const destinationDevice = await context.parseVariablesInString(opt.destinationDeviceAdddress); 
				const destinationChannel = await context.parseVariablesInString(opt.destinationChannelNumber);
				self.clearCrosspoint(destinationDevice, destinationChannel)
			}
		};
		
		
		actions.clearCrosspointDropDown = {
			name: 'Clear Crosspoint (drop down menu)',
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: self.devicesChoices
				}
			],
			callback: async function (action) {
				const opt = action.options;
 				self.clearCrosspoint(opt.destinationDevice,	opt['destinationChannel_'+opt.destinationDevice]);
			}
		}

		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'Destination channel',
				id: 'destinationChannel_'+ ip,
				choices: this.rxChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return options.destinationDevice == deviceIp}
			}
			actions.clearCrosspointDropDown.options.push(nameOption);
		}
		
		actions.setDeviceName = {
			name: 'Set Device name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				},
				{
					type: 'textinput',
					label: 'New name',
					id: 'name',
					default: '',
					useVariables: true
				}
			],
			callback: async function (action, context) {
				const opt = action.options;
				const name = await context.parseVariablesInString(opt.name);
 				self.setDeviceName(opt.device, name);
			},
		}


		actions.setDeviceNameCustom = {
			name: 'Set Device name (custom device)',
			options: [
				{
					type: 'textinput',
					label: 'Device',
					id: 'device',
					useVariables: true,
				},
				{
					type: 'textinput',
					label: 'New name',
					id: 'name',
					default: '',
					useVariables: true
				}
			],
			callback: async function (action, context) {
				const opt = action.options;
				const device = await context.parseVariablesInString(opt.device);
 				self.setDeviceName(device, opt.name);
			},
		}
		
		actions.resetDeviceName = {
			name: 'Reset Device name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				},
			],
			callback: async function (action, context) {
				let opt = action.options;
 				self.resetDeviceName(opt.device);
			},
		}
		
		actions.setRxChannelName = {
			name: 'Set Rx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				}
			],
			callback: async function (action, context) {
				const opt = action.options;
				const newName = await context.parseVariablesInString(opt.newName);
				self.setRxChannelName(opt.device, opt['channel_'+opt.device], newName);
			}
		}
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'channel',
				id: 'channel_'+ ip,
				choices: this.rxChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return options.device == deviceIp}
			}
			actions.setRxChannelName.options.push(nameOption);
		}
		actions.setRxChannelName.options.push({
			type: 'textinput',
			label: 'New name', 
			id: 'newName',
			useVariables: true,
		});
		
		actions.resetRxChannelName = {
			name: 'Reset Rx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				}
			],
			callback: async function (action, context) {
				const opt = action.options;
				const newName = await context.parseVariablesInString(opt.newName);
				self.resetRxChannelName(opt.device, opt['channel_'+opt.device]);
			}
		}
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'channel',
				id: 'channel_'+ ip,
				choices: this.rxChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return options.device == deviceIp}
			}
			actions.resetRxChannelName.options.push(nameOption);
		}
		
		actions.setTxChannelName = {
			name: 'Set Tx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				}
			],
			callback: async function (action, context) {
				const opt = action.options;
				const newName = await context.parseVariablesInString(opt.newName);
				self.setTxChannelName(opt.device, opt['channel_'+opt.device], newName);
			}
		}
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'channel',
				id: 'channel_'+ ip,
				choices: this.txChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return options.device == deviceIp}
			}
			actions.setTxChannelName.options.push(nameOption);
		}
		actions.setTxChannelName.options.push({
			type: 'textinput',
			label: 'New name', 
			id: 'newName',
			useVariables: true,
		});
		
		actions.resetTxChannelName = {
			name: 'Reset Tx channel name',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				}
			],
			callback: async function (action, context) {
				const opt = action.options;
				const newName = await context.parseVariablesInString(opt.newName);
				self.resetTxChannelName(opt.device, opt['channel_'+opt.device]);
			}
		}
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'channel',
				id: 'channel_'+ ip,
				choices: this.txChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return options.device == deviceIp}
			}
			actions.resetTxChannelName.options.push(nameOption);
		}

		
		actions.setLatency = {
			name: 'Set Latency',
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: self.devicesChoices
				},
				{
					type: 'textinput',
					label: 'Latency (in ms)',
					id: 'latency',
					default: '1',
					useVariables: true
				}
			],
			callback: async function (action, context) {
				const opt = action.options;
				const latency = await context.parseVariablesInString(opt.latency);
 				self.setLatency(opt.destinationDevice, opt.latency);
			}
		}
		
		actions.setSampleRateCustom = {
			name: 'Set Sample rate (custom)',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				},
				{
					type: 'textinput',
					label: 'Sample rate (in Hz)',
					id: 'sr',
					default: '48000',
					useVariables: true
				}
			],
			callback: async function (action, context) {
				let opt = action.options;
				const sr = await context.parseVariablesInString(opt.sr);
 				self.setSampleRate(opt.device, sr);
			}
		}
		
		actions.setSampleRate = {
			name: 'Set Sample rate',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				},
			],
			callback: async function (action, context) {
				const opt = action.options;
				const ip = opt.device;
 				self.setSampleRate(ip, opt['sr_' + ip]);
			},
		}

		for (const [ip, device] of Object.entries(self.devicesData)) {
			let srOptions = {
				type: 'dropdown',
				label: 'Sample rate',
				id: 'sr_'+ ip,
				choices: array2choices(device.srOptions, (f) => { return (f/1000).toString() + ' kHz'}),
				isVisibleData : {deviceIp: ip},
				isVisible: (options, data) => { return options.device == data.deviceIp}
			}
			actions.setSampleRate.options.push(srOptions);
		}

		
		actions.setPullup = {
			name: 'Set Sample rate pullup',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				},
			],
			callback: async function (action, context) {
				const opt = action.options;
 				self.setPullup(ip, opt['pullup_' + ip]);
			},
		}

		for (const [ip, device] of Object.entries(self.devicesData)) {
			let pullupOptions = {
				type: 'dropdown',
				label: 'Sample rate pullup',
				id: 'pullup_'+ ip,
				choices: object2PartialChoices(DANTE_CONST.PULLUPS, device.pullupOptions),
				isVisibleData : {deviceIp: ip},
				isVisible: (options, data) => { return options.device == data.deviceIp}
			}
			actions.setPullup.options.push(pullupOptions);
		}

		
		actions.setEncoding = {
			name: 'Set Encoding',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				},
			],
			callback: async function (action, context) {
				const opt = action.options;
				const device = opt.device;
 				self.setEncoding(device, opt['encoding_' + device]);
			},
		}

		for (const [ip, device] of Object.entries(self.devicesData)) {
			let encodingOptions = {
				type: 'dropdown',
				label: 'Encoding',
				id: 'encoding_'+ ip,
				choices: object2PartialChoices(DANTE_CONST.ENCODINGS, device.encodingOptions),
				isVisibleData : {deviceIp: ip},
				isVisible: (options, data) => { return (options.device == data.deviceIp);}
			}
			actions.setEncoding.options.push(encodingOptions);
		}

		
		
		actions.setOutputLevel = {
			name: 'Set Output Level',
			options: [
				{
					type: 'dropdown',
					label: 'Device',
					id: 'device',
					choices: self.devicesChoices
				}
			],
			callback: async function (action, context) {
				let opt = action.options;
 				self.setLevel(opt.destinationDevice, 'out', opt['channel_' + opt.destinationDevice], opt.level);
			}
		}
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let levelOption = {
				type: 'dropdown',
				label: 'Channel',
				id: 'channel_'+ ip,
				choices: this.rxChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return options.device == deviceIp}
			}
			actions.setOutputLevel.options.push(levelOption);
		}
		actions.setOutputLevel.options.push({
					type: 'dropdown',
					label: 'Level',
					id: 'level',
					choices: object2choices(DANTE_CONST.LEVELS),
					default: 2
				});
		
		actions.refresh = {
			name: 'Refresh parameters',
			options : [],
			callback : async function (action, context) {
				self.refreshSettings();
				self.refreshArc();
			}
		};
				
		
		self.setActionDefinitions(actions);
	}
}
