module.exports = {
	// ##########################
	// #### Instance Actions ####
	// ##########################
	setActions: function () {
		let self = this;
		let actions = {};

		// ########################
		// ####    Actions     ####
		// ########################

		actions.makeCrosspoint = {
			label: 'Make Crosspoint',
			options: [
				{
					type: 'textinput',
					label: 'Source Channel Name',
					id: 'sourceChannelName',
					default: 'Input 1'
				},
				{
					type: 'textinput',
					label: 'Source Device Name',
					id: 'sourceDeviceName',
					default: 'MyDanteDeviceName'
				},
				{
					type: 'textinput',
					label: 'Destination Channel Number',
					id: 'destinationChannelNumber',
					default: '3'
				}
			],
			callback: function (action, bank) {
				let opt = action.options;
				self.makeCrosspoint(opt.sourceChannelName, opt.sourceDeviceName, opt.destinationChannelNumber)
			}
		}

		actions.clearCrosspoint = {
			label: 'Clear Crosspoint',
			options: [
				{
					type: 'textinput',
					label: 'Destination Channel Number',
					id: 'destinationChannelNumber',
					default: '3'
				}
			],
			callback: function (action, bank) {
				let opt = action.options;
				self.clearCrosspoint(opt.destinationChannelNumber)
			}
		}

		return actions
	}
}