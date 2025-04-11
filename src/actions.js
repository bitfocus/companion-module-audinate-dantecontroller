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
					id: 'destinationDeviceAdddress',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
			],
			callback: async function (action) {
				let opt = action.options;
				self.makeCrosspoint(opt.destinationDeviceAdddress, opt.sourceChannelName, opt.sourceDeviceName, opt.destinationChannelNumber)
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
				
				//self.makeCrosspoint(self.devicesIp[opt.destinationDevice], opt['sourceChannel_'+opt.sourceDevice], opt.sourceDevice, opt['destinationChannel_'+opt.destinationDevice]);
				console.log(self.devicesIp[opt.destinationDevice], opt['sourceChannel_'+opt.sourceDevice], opt.sourceDevice, opt['destinationChannel_'+opt.destinationDevice]);
			}
		}

		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'Destination channel',
				id: 'destinationChannel_'+ device.name,
				choices: this.destChannelsChoice[device.name],
				isVisibleData : device.name,
				isVisible: (options, name) => { return (options.destinationDevice == name);}
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
				id: 'sourceChannel_'+ device.name,
				choices: this.sourceChannelsChoice[device.name],
				isVisibleData : device.name,
				isVisible: (options, name) => { return (options.sourceDevice == name);}
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
				
				//self.clearCosspoint(self.devicesIp[opt.destinationDevice], opt['destinationChannel_'+opt.destinationDevice]);
				console.log(self.devicesIp[opt.destinationDevice], opt['destinationChannel_'+opt.destinationDevice]);
			}
		}

		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'Destination channel',
				id: 'destinationChannel_'+ device.name,
				choices: this.destChannelsChoice[device.name],
				isVisibleData : device.name,
				isVisible: (options, name) => { return (options.destinationDevice == name);}
			}
			actions.clearCrosspointDropDown.options.push(nameOption);
		}
		
		
		self.setActionDefinitions(actions);
	}
}