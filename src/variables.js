module.exports = {
	initVariables: function () {
		let self = this;

		let variables = [];
		
		variables.push({variableId: 'devices', name: 'Dante Devices'});
		
		for (const [ip, device] of Object.entries(self.devicesData)) {
			variables.push({variableId: device.name + 'tx', name: device.name + '_OUT'});
			variables.push({variableId: device.name + 'rx', name: device.name + '_IN'});
			variables.push({variableId: device.name + 'sr', name: device.name + '_SampleRate'});
			variables.push({variableId: device.name + 'latency', name: device.name + '_Latency'});
		}
			
		self.setVariableDefinitions(variables);
	},

	checkVariables: function (...variableTypes) {
		let self = this;
		const variableValues = {};
		const devicesList = [];

		const channelNames = {};
		if(!variableTypes) {
		  variableTypes = ['devices','rx', 'tx', 'sr', 'latency'];
		}
		
		for (const [ip, device] of Object.entries(self.devicesData)) {
			deviceName = device?.name;
			if (deviceName) {
				for (let variableType of variableTypes) {
					switch (variableType) {
						case 'device' :
							if (!variableValues.devices) {
								variableValues.devices = [];
							}
		          variableValues.devices.push(deviceName);
		          break;
		          
		      	case 'rx':
		      	case 'tx':
		      		let channelArray = variableValues[deviceName + variableType] = [];
		      		for (let i=0; i < device[variableType]?.count; i++) {
		      			channelArray[i] = device[variableType][i+1]?.name;
		      		}
		      		break;
		          
		    	  case 'sr':
		    	  case 'latency':
		    	  	variableValues[deviceName + variableType] = device[variableType];
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
