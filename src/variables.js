module.exports = {
	initVariables: function () {
		let self = this;

		let variables = [];

		variables.push({ variableId: 'channel_count', name: 'Channel Count' })

		self.setVariableDefinitions(variables);
	},

	checkVariables: function () {
		let self = this;

		try {
			self.setVariableValues({
				'channel_count': self.DEVICEINFO.channelCount
			});
		}
		catch(error) {
			self.log('error', 'Error setting variables: ' + error);
		}
	}
}
