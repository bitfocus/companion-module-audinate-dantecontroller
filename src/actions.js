module.exports = {
	initActions: function () {
		let self = this;
		let actions = {};

		actions.makeCrosspoint = {
			name: 'Make Crosspoint',
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
			callback: async function (action) {
				let opt = action.options;
				self.makeCrosspoint(opt.sourceChannelName, opt.sourceDeviceName, opt.destinationChannelNumber)
			}
		}

		actions.clearCrosspoint = {
			name: 'Clear Crosspoint',
			options: [
				{
					type: 'textinput',
					label: 'Destination Channel Number',
					id: 'destinationChannelNumber',
					default: '3'
				}
			],
			callback: async function (action) {
				let opt = action.options;
				self.clearCrosspoint(opt.destinationChannelNumber)
			}
		}

		self.setActionDefinitions(actions);
	}
}