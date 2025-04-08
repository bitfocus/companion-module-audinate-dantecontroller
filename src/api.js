const Dante = require('dante-control');
const mdns = require('multicast-dns');

module.exports = {
	initConnection: function () {
		let self = this;
	
		//create dante object
		console.log('creating new dante object');
		self.DANTE = new Dante();
		console.log('getting information function');
		self.devices = [];
		self.getInformation();

		self.setupInterval();
	},

	updateDevices: function(response){
		if ((response?.answer?.name) && (self.devices.includes(response.answer.name))) {
			self.devices.push(response.answer.name);
		}
	},
	
	
	setupInterval: function() {
		let self = this;
	
		self.stopInterval();
	
		if (self.config.interval > 0) {
			self.INTERVAL = setInterval(self.getInformation.bind(self), self.config.interval);
			self.log('info', 'Starting Update Interval: Every ' + self.config.interval + 'ms');
		}
	},
	
	stopInterval: function() {
		let self = this;
	
		if (self.INTERVAL !== null) {
			self.log('info', 'Stopping Update Interval.');
			clearInterval(self.INTERVAL);
			self.INTERVAL = null;
		}
	},
	
	getInformation: async function () {
		//Get all information from Device
		let self = this;

		console.log('getting info');
	
		if (self.DANTE) {
			self.config.host = '10.20.12.81';
			console.log('getting channel count');
			self.DEVICEINFO.channelCount = await self.DANTE.getChannelCount(self.config.host);
			console.log('getting channel names');
			self.DEVICEINFO.channelNames = await self.DANTE.getChannelNames(self.config.host);
	
			console.log('****info***')
			console.log(self.DEVICEINFO.toString());
		}
		
	},
	
	updateData: function (bytes) {
		let self = this;
	
		//do more stuff
	
		self.checkFeedbacks();
		self.checkVariables();
	},
	
	makeCrosspoint: function(sourceChannelName, sourceDeviceName, destinationChannelNumber) {
		let self = this;
	
		self.DANTE.makeCrosspoint(sourceChannelName, sourceDeviceName, destinationChannelNumber);
	},
	
	clearCrosspoint: function(destinationChannelNumber) {
		let self = this;
	
		self.DANTE.clearCrosspoint(destinationChannelNumber);
	}
}
