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
				let opt = action.options;
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
				isVisible: (options, deviceIp) => { return (options.destinationDevice == deviceIp);}
			}
			actions.clearCrosspointDropDown.options.push(nameOption);
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
					//type: 'dropdown',
					label: 'Latency (in ms)',
					id: 'latency',
					default: '1',
					useVariables: true
				}
			],
			callback: async function (action) {
				let opt = action.options;
 				self.setLatency(opt.destinationDevice, opt.latency);
			}
		}
		
		
		self.setActionDefinitions(actions);
	}
}
