module.exports = {
	initVariables: function () {
		let self = this;

		let variables = [];

		variables.push({ variableId: 'channel_count', name: 'Channel Count' });
		variables.push({variableId: 'devices', name: 'Dante Devices'});
		variables.push({variableId: 'devices_channels', name: 'Devices Channels Count'});
			
		self.setVariableDefinitions(variables);
	},

	checkVariables: function () {
		let self = this;

		try {
			self.setVariableValues({
				'channel_count': self.DEVICEINFO.channelCount,
				'devices': self.devices,
				'devices_channels': self.devices_channels
			});
		}
		catch(error) {
			self.log('error', 'Error setting variables: ' + error);
		}
	}
}
