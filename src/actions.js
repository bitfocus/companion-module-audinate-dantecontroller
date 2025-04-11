module.exports = {
	initActions: function () {
		let self = this;
		let actions = {};
		self.log('debug', 'actions');
			
		self.updateCount = function() {
		  this.count++;
		  this.myTextOptions[0].value=this.num;
		  this.log('debug', this.myTextOptions[0].LABEL);
		  this.log('debug', this.myTextOptions[0].value);
		  this.initActions();
		}
		
		if (self.count ==undefined) {
		  self.count =0;
		  self.num = self.count.toString();
		  self.testInterval = setInterval(self.updateCount.bind(this), 3000);
		}
		
		self.myTextOptions = [{
		  id: 'test',
		  label: 'TEST',
		  type: "static-text",
		  value: self.num
		}];
	
		
		

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
		};
		
		actions.test ={
		  name : 'test',
		  options: self.myTextOptions,
		  callback: async function (action) {
		    self.log('debug', action.options.test);
		  }
		}

		self.setActionDefinitions(actions);
	}
}