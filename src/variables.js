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
			variables.push({variableId: device.name + '_pullup', name: 'Sample rate pullup of ' + device.name});
			variables.push({variableId: device.name + '_latency', name: 'Latency of ' + device.name + ' (in ms)'});
			variables.push({variableId: device.name + '_encoding', name: 'Encoding of ' + device.name});
			variables.push({variableId: device.name + '_output_levels', name: 'Output levels of ' + device.name});
			variables.push({variableId: device.name + '_model_name', name: 'Model name of ' + device.name});
			variables.push({variableId: device.name + '_product_version', name: 'Product version of ' + device.name});
		}
			
		self.setVariableDefinitions(variables);
	},

	checkVariables: function (ipAddress, ...variableTypes) {
		let self = this;
		const variableValues = {};
//		let devicesList;
//
//		if(ipAddress && ipAddress != 'all') {
//			devicesList = [[ipAddress, self.devicesData[ipAddress]]];
//		} else {
//			devicesList = Object.entries(self.devicesData);
//		}
		if(!(variableTypes?.length > 0)) {
		  variableTypes = ['ip', 'rx', 'tx', 'rx_names', 'tx_names', 'sr', 'latency', 'encoding', 'output_levels', 'manf'];
		}

		for ([ip, device] of Object.entries(self.devicesData)) { 
			let deviceName = device?.name;
			if (deviceName) {
				if (!variableValues.devices) {
						variableValues.devices = [];
					}
				variableValues.devices.push(deviceName);
				
				if (ip == ipAddress) {
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
									const channel = device[channelType][i+1];
									channelArray[i] = channelType == 'tx' ? self.getChannelSubscriptionName(channel) : channel?.name;
								}
								break;
							
							case 'sr':
							case 'latency':
							case 'encoding':
							case 'pullup':
							case 'output_levels': 
								variableValues[deviceName + '_' + variableType] = device[variableType];
								break;
								
							case 'manf':
								variableValues[deviceName + '_model_name'] = device.modelName; 
								let versionString = device.productVersionString ? device.productVersionString : ''+device.productVersionMajor+'.'+ device.productVersionMinor+ '.'+ device.productVersionPatch;
								variableValues[deviceName + '_product_version'] = versionString;
								break;
								
						}
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
