module.exports = {
	initVariables: function () {
		let self = this;

		let variables = [];
		
		variables.push({variableId: 'devices', name: 'Dante Devices'});
		
		for (const [ip, device] of Object.entries(self.devicesData)) {
			variables.push({variableId: device.name + '_ip', name: 'Ip address of ' + device.name});
			variables.push({variableId: device.name + '_tx', name: 'Number of outputs for ' + device.name});
			variables.push({variableId: device.name + '_tx_names', name: 'Output names for ' + device.name});
			variables.push({variableId: device.name + '_rx', name: 'Number of inputs for ' + device.name});
			variables.push({variableId: device.name + '_rx_names', name: ' Input names for ' + device.name});
			variables.push({variableId: device.name + '_sr', name: 'Sample rate of ' + device.name});
			variables.push({variableId: device.name + '_latency', name: 'Latency of ' + device.name + ' (in ms)'});
		}
			
		self.setVariableDefinitions(variables);
	},

	checkVariables: function (ipAddress, ...variableTypes) {
		let self = this;
		const variableValues = {};
		let devicesList;

		if(ipAddress && ipAddress != 'all') {
			devicesList = [ipAddress, self.devicesData[ipAddress]];
		} else {
			devicesList = Object.entries(self.devicesData);
		}
		if(!(variableTypes?.length > 0)) {
		  variableTypes = ['devices', 'ip', 'rx', 'tx', 'rx_names', 'tx_names', 'sr', 'latency'];
		}
		
		for (const item of devicesList) {
			const ip = item[0];
			const device = item[1];
			let deviceName = device?.name;
			if (deviceName) { 
				for (let variableType of variableTypes) {
					switch (variableType) {
						case 'devices' :
							if (!variableValues.devices) {
								variableValues.devices = [];
							}
						variableValues.devices.push(deviceName);
						break;
				  
						case 'ip' :
							variableValues[deviceName + '_ip'] = ip;
							break;
					
						case 'rx':
						case 'tx':
							variableValues[deviceName + '_' + variableType] = device[variableType]?.count;
							break;
							
						case 'rx_names':
						case 'tx_names':
							let channelArray = variableValues[deviceName + '_' + variableType] = [];
							const channelType = variableType.slice(0, 2);
							for (let i=0; i < device[channelType]?.count; i++) {
								channelArray[i] = device[channelType][i+1]?.name;
							}
							break;
						
						case 'sr':
						case 'latency':
							variableValues[deviceName + '_' + variableType] = device[variableType];
							break;
					}
				}
			}
		}

		try {
			self.setVariableValues(variableValues);
		}
		catch(error) {
			self.log('error', 'Error setting variables: ' + error);
		}
	}
}
