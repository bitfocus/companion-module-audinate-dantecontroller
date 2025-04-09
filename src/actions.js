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
					default: 'Input 1',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Source Device Name',
					id: 'sourceDeviceName',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Channel Number',
					id: 'destinationChannelNumber',
					default: '3',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Device Address',
					id: 'destinationDeviceAdddress',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
			],
			callback: async function (action) {
				let opt = action.options;
				self.makeCrosspoint(opt.destinationDeviceAdddress, opt.sourceChannelName, opt.sourceDeviceName, opt.destinationChannelNumber)
			}
		}

		actions.clearCrosspoint = {
			name: 'Clear Crosspoint',
			options: [
				{
					type: 'textinput',
					label: 'Destination Channel Number',
					id: 'destinationChannelNumber',
					default: '3',
					useVariables: true
				},
				{
					type: 'textinput',
					label: 'Destination Device Address',
					id: 'destinationDeviceAdddress',
					default: 'MyDanteDeviceName',
					useVariables: true
				},
			],
			callback: async function (action) {
				let opt = action.options;
				self.clearCrosspoint(opt.destinationDeviceAdddress, opt.destinationChannelNumber)
			}
		}

		self.setActionDefinitions(actions);
	}
}