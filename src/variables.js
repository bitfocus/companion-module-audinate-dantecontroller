module.exports = {
	initVariables: function () {
		let self = this;

		let variables = [];

		variables.push({ variableId: 'channel_count', name: 'Channel Count' });
		variables.push({variableId: 'devices', name: 'Dante Devices'});
			
		self.setVariableDefinitions(variables);
	},

	checkVariables: function () {
		let self = this;

		try {
			self.setVariableValues({
				'channel_count': self.DEVICEINFO.channelCount,
				'devices': self.Dante.devices
			});
		}
		catch(error) {
			self.log('error', 'Error setting variables: ' + error);
		}
	}
}
