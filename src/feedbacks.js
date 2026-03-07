const { combineRgb } = require('@companion-module/base');
const { Regex } = require('@companion-module/base')

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
					const selectedSourceChannel = opt['sourceChannel_'+opt.sourceDevice];
					const sourceChannel = self.devicesData[opt.sourceDevice]?.tx?.[selectedSourceChannel] || self.findTxChannelByName(opt.sourceDevice, selectedSourceChannel);
					const normalizeName = (name) => String(name ?? '').trim().toLowerCase();
					const destinationSourceChannelName = normalizeName(destinationChannel?.sourceChannel);
					const sourceChannelCandidates = [selectedSourceChannel, self.getChannelSubscriptionName(sourceChannel), sourceChannel?.name, sourceChannel?.friendlyName]
						.filter(Boolean)
						.map((name) => normalizeName(name));
					if (sourceChannel?.number != undefined) {
						const number = parseInt(sourceChannel.number, 10);
						if (!isNaN(number)) {
							sourceChannelCandidates.push(String(number), String(number).padStart(2, '0'));
						}
					}
					const sourceChannelMatches = sourceChannelCandidates.includes(destinationSourceChannelName);
					const destinationSourceDeviceName = normalizeName(destinationChannel?.sourceDevice);
					const selectedSourceDeviceName = normalizeName(self.devicesData[opt.sourceDevice]?.name);
					const sourceDeviceMatches = destinationSourceDeviceName == selectedSourceDeviceName ||
						(destinationSourceDeviceName == '.' && opt.destinationDevice == opt.sourceDevice);
					const subscriptionOk = ([9, 10, 14].includes(destinationChannel?.subscriptionStatus));
					return sourceDeviceMatches && sourceChannelMatches && subscriptionOk;
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
		
	feedbacks['routing_bg_manual'] = {
		type: 'boolean',
		name: 'Change background color by destination (manual)',
		description: 'If the specified source channel specified is routed to the correct output, change background color of the button',
		defaultStyle: {
           color: combineRgb(0, 0, 0),
			bgcolor: combineRgb(255, 255, 0),
		},
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
				label: 'Destination Channel',
				id: 'destinationChannelId',
				default: '1',
				useVariables: true
			},
			{
				type: 'textinput',
				label: 'Destination Device',
				id: 'destinationDeviceId',
				default: 'MyDanteDevice',
				useVariables: true
			},	
		],
		callback: async function (feedback, context) {
			const opt = feedback.options;
			const sourceChannelName = await context.parseVariablesInString(opt.sourceChannelName);
			const sourceDeviceName = await context.parseVariablesInString(opt.sourceDeviceName);
			const destinationChannelId = await context.parseVariablesInString(opt.destinationChannelId);
			const destinationDeviceId = await context.parseVariablesInString(opt.destinationDeviceId);

			// Check if destinationDeviceId is an IP or a name
			const IP = RegExp(Regex.IP.slice(1,-1));
			const destinationDeviceIp = IP.test(destinationDeviceId) ? destinationDeviceId : self.findDeviceIpByName(destinationDeviceId);
			
			if (destinationDeviceIp && sourceDeviceName && self.devicesData[destinationDeviceIp]?.rx) {
				const destinationChannel = self.findRxChannelByName(destinationDeviceIp, destinationChannelId) ?? self.devicesData[destinationDeviceIp].rx[destinationChannelId];
				if (destinationChannel == undefined) {
					return
				}
				
				const sourceChannel = self.findTxChannelByName(sourceDeviceName, sourceChannelName);
				const normalizeName = (name) => String(name ?? '').trim().toLowerCase();
				const destinationSourceChannelName = normalizeName(destinationChannel?.sourceChannel);
				const sourceChannelCandidates = [sourceChannelName, self.getChannelSubscriptionName(sourceChannel), sourceChannel?.name, sourceChannel?.friendlyName]
					.filter(Boolean)
					.map((name) => normalizeName(name));
				if (sourceChannel?.number != undefined) {
					const number = parseInt(sourceChannel.number, 10);
					if (!isNaN(number)) {
						sourceChannelCandidates.push(String(number), String(number).padStart(2, '0'));
					}
				}
				
				const sourceChannelMatches = sourceChannelCandidates.includes(destinationSourceChannelName);
				const destinationSourceDeviceName = normalizeName(destinationChannel?.sourceDevice);
				const selectedSourceDeviceName = normalizeName(sourceDeviceName);
				const sourceDeviceMatches = destinationSourceDeviceName == selectedSourceDeviceName ||
					(destinationSourceDeviceName == '.' && self.devicesData[destinationDeviceIP].name == sourceDeviceName);
				const subscriptionOk = ([9, 10, 14].includes(destinationChannel?.subscriptionStatus));
				return sourceDeviceMatches && sourceChannelMatches && subscriptionOk;
			}
		},
	}
		
		self.setFeedbackDefinitions(feedbacks);
	}
}
