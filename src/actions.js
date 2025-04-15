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
					label: 'Destination Channel Number',
					id: 'destinationChannelNumber',
					default: '3',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Device Address',
					id: 'destinationDeviceAddress',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
			],
			callback: async function (action) {
				let opt = action.options;
				self.makeCrosspoint(opt.destinationDeviceAddress, opt.sourceChannelName, opt.sourceDeviceName, opt.destinationChannelNumber)
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
				console.log('ACTION');
				self.makeCrosspoint(opt.destinationDevice, opt['sourceChannel_'+opt.sourceDevice], self.devicesData[opt.sourceDevice]?.name, opt['destinationChannel_'+opt.destinationDevice]);
				console.log(opt.destinationDevice, opt['sourceChannel_'+opt.sourceDevice], self.devicesData[opt.sourceDevice]?.name, opt['destinationChannel_'+opt.destinationDevice]);
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
					label: 'Destination Channel Number',
					id: 'destinationChannelNumber',
					default: '3',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Device Address',
					id: 'destinationDeviceAdddress',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
			],
			callback: async function (action) {
				let opt = action.options;
				self.clearCrosspoint(opt.destinationDeviceAdddress, opt.destinationChannelNumber)
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
				console.log(opt.destinationDevice,	opt['destinationChannel_'+opt.destinationDevice]);
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
		
		
		self.setActionDefinitions(actions);
	}
}