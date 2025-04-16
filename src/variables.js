module.exports = {
	initVariables: function () {
		let self = this;

		let variables = [];
		
		variables.push({variableId: 'devices', name: 'Dante Devices'});
		
		for (const [ip, device] of Object.entries(self.devicesData)) {
			variables.push({variableId: device.name + 'tx', name: device.name + ' OUT'});
			variables.push({variableId: device.name + 'rx', name: device.name + ' IN'});
		}
			
		self.setVariableDefinitions(variables);
	},

	checkVariables: function () {
		let self = this;
		const devicesList = [];
		const channelNames = {};
		
		for (const [ip, device] of Object.entries(self.devicesData)) {
			deviceName = device?.name;
			if (deviceName) {
				devicesList.push(deviceName);
				channelNames[deviceName]={rx: [], tx: []};
				
				for (ioString of ['rx', 'tx']){
					channelsChoices = this[ioString+'ChannelsChoices'][deviceName];
					if (channelsChoices) {
						for (let i = 1; i < channelsChoices.length; i++) {
//						channelsChoices.forEach((channelChoice) => {
							channelNames[deviceName][ioString].push(channelsChoices[i]?.label);
						}//);
					}
				}
			}		
		}

		try {
			const variableValues = {};
			variableValues.devices = devicesList;

			for (const [deviceName, channels] of Object.entries(channelNames)) {
				for (const ioString of ['rx', 'tx']) {
					variableValues[deviceName + ioString] = channels[ioString];
				}
			}
			self.setVariableValues(variableValues);
		}
		catch(error) {
			self.log('error', 'Error setting variables: ' + error);
		}
	}
}
