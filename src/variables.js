module.exports = {
	initVariables: function () {
		let self = this;

		let variables = [];
		
		variables.push({variableId: 'devices', name: 'Dante Devices'});
			
		self.setVariableDefinitions(variables);
	},

	checkVariables: function () {
		let self = this;
		const devicesList = [];
		for (const [ip, device] of Object.entries(self.devicesData)) {
			devicesList.push(device?.name);
		}

		try {
			self.setVariableValues({
				'devices': devicesList,
			});
		}
		catch(error) {
			self.log('error', 'Error setting variables: ' + error);
		}
	}
}
