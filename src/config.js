const { Regex } = require('@companion-module/base')
const { networkInterfaces } = require('os');

module.exports = {
	getConfigFields() {
		
		let self = this;
		
		// get network cards
		const nets = networkInterfaces();
		let nics = {};
		for (const name of Object.keys(nets)) {
			for (const net of nets[name]) { 
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        // 'IPv4' is in Node <= 17, from 18 it's a number 4 or 6
				const familyV4Value = (typeof net.family === 'string') ? 'IPv4' : 4
				if (net.family === familyV4Value && !net.internal) {
					if (!nics[name]) {
						nics[name] = [];
					}
					nics[name].push(net.address);
				}
			}
		}
		
		
		self.nicChoices = [{id: '', label: 'All'}];
		for (const [name, ips] of Object.entries(nics)) {
			for (let ip of ips) {
				self.nicChoices.push({id: ip, label: (name + ' : ' + ip)});
			}
		}
		

		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: 'This module controls Dante devices',
			},

			{
				type: 'dropdown',
				label: 'IP and network card',
				id: 'ip',
				tooltip: 'Choose network card and IP address bound to Dante Controller.',
				width: 12,
				choices: self.nicChoices
			},

			{
				type: 'textinput',
				id: 'interval',
				label: 'Update Interval',
				tooltip: 'Please enter the amount of time in milliseconds to request new information from the device. Set to 0 to disable.',
				width: 3,
				default: 1000
			},
		
			{
				type: 'textinput',
				id: 'timeoutInterval',
				label: 'Timeout Interval',
				tooltip: 'Please enter the time in milliseconds before a device is considered offline. Set to 0 to disable.',
				width: 3,
				default: 3000
			},
			
			{
				type: 'static-text',
				id: 'info2',
				label: 'Verbose Logging',
				width: 12,
				value: `Enabling this option will put more detail in the log, which can be useful for troubleshooting purposes.`
			},
			
			{
				type: 'checkbox',
				id: 'verbose',
				label: 'Enable Verbose Logging',
				default: false
			},
		]
	}
}
