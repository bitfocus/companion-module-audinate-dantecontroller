module.exports = {
	// ##########################
	// #### Define Variables ####
	// ##########################
	setVariables: function () {
		let self = this;

		let variables = [];

		variables.push({ name: 'channel_count', label: 'Channel Count' })

		return variables
	},

	// #########################
	// #### Check Variables ####
	// #########################
	checkVariables: function () {
		let self = this;

		try {
			self.setVariable('channel_count', self.DEVICEINFO.channelCount);
		}
		catch(error) {
		}
	}
}
