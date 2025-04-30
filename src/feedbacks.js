const { combineRgb } = require('@companion-module/base');

module.exports = {
	initFeedbacks: function () {
		let self = this;
		let feedbacks = {};

		const foregroundColor = combineRgb(255, 255, 255) // White
		const backgroundColorRed = combineRgb(255, 0, 0) // Red
		
		
		feedbacks['routing_bg'] = {
			type: 'boolean',
			name: 'Change background color by destination',
			description: 'If the specified source channel specified is routed to the correct output, change background color of the button',
			defaultStyle: {
            color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			options: [
				{
					type: 'dropdown',
					label: 'Destination Device',
					id: 'destinationDevice',
					choices: self.devicesChoices
				}		
			],
			callback: (feedback) => {
				let opt = feedback.options;
				if (opt.destinationDevice && self.devicesData[opt.destinationDevice]?.rx && opt.sourceDevice) {
					let destinationChannel = self.devicesData[opt.destinationDevice].rx[opt['destinationChannel_'+opt.destinationDevice]];
					return (destinationChannel?.sourceDevice == self.devicesData[opt.sourceDevice]?.name) &&
						(destinationChannel?.sourceChannel == opt['sourceChannel_'+opt.sourceDevice]) && ([9, 10, 14].includes(destinationChannel?.subscriptionStatus));
				}	
			},
		}
		
		
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'Destination channel',
				id: 'destinationChannel_'+ ip,
				choices: this.rxChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return (options.destinationDevice == deviceIp);}
			}
			feedbacks.routing_bg.options.push(nameOption);
		}
		
		feedbacks.routing_bg.options.push({
					type: 'dropdown',
					label: 'Source Device',
					id: 'sourceDevice',
					choices: this.devicesChoices
				})
	
		for (const [ip, device] of Object.entries(self.devicesData)) {
			let nameOption = {
				type: 'dropdown',
				label: 'Source channel',
				id: 'sourceChannel_'+ ip,
				choices: this.txChannelsChoices[device.name],
				isVisibleData : ip,
				isVisible: (options, deviceIp) => { return (options.sourceDevice == deviceIp);}
			}
			feedbacks.routing_bg.options.push(nameOption);
		}	
		
		self.setFeedbackDefinitions(feedbacks);
	}
}
