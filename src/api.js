const multidns = require('multicast-dns');
const dgram = require("dgram");
const merge = require("./utils/merge");
const { networkInterfaces } = require('os');
const { InstanceStatus, Regex } = require('@companion-module/base')
const {DANTE_CONST, object2choices} = require("./const");



const compareArrays = (a, b) => {
  return JSON.stringify(a) === JSON.stringify(b);
};

//**
//** utils functions to parse dante messages
//**

const intToBuffer = (number, bytes = 2) => {
	if (bytes < 1 || bytes > 8) {
		return;
	}
    let intBuffer = Buffer.alloc(bytes);
	switch (bytes) {
		case 1:
			intBuffer.writeInt8(number);
			break;
		case 2:
		case 3:
			intBuffer.writeUInt16BE(number, bytes - 2);
			break;
		case 4:
		case 5:
		case 6:
		case 7:
			intBuffer.writeUint32BE(number, bytes - 4);
			break;
		case 8:
			intBuffer.writeBigUInt64BE(number);
	}
			
    return intBuffer;
};

const bufferToInt = (buffer, offset = 0, bytes = 2) => {
	switch (bytes) {
		case 1:
			return buffer.readInt8(offset);
		case 2:
			return buffer.readUInt16BE(offset);
		case 4:
			return buffer.readUint32BE(offset);
		case 8:
			return buffer.readBigUInt64BE(offset);
	}
};

const incrementBE = (buffer) => {
    for (var i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i]++ !== 255) break;
    }
};

const parseString = (buffer, startIndex) => {
  const end = buffer.indexOf(0x00, startIndex);
  if (buffer.length > startIndex) {
	return buffer.toString('utf8', startIndex, end);
  }
};


//** 
//** Dante messages parsing
//**

const parseChannelCount = (reply) => {
    const deviceInfo = { tx: {count: reply[13]}, rx :{count:reply[15]} };
    return deviceInfo;
};

const parseTxFriendlyNames = (reply) => {
	const deviceInfo = {};
	deviceInfo.tx = {};
	let firstChannelGroup;
	
	const channelCount = reply[10];
	const recCount = reply[11];
	const startIndex = 12;


	// set offsets
	const infoBufferSize = 6;
	const nameNumberOffset = 2;
	const friendlyNameIndexOffset = 4;
	
	// for each channel
	for (let i = 0; i < Math.min(recCount,32) ; i++) {
		// get info chunk of channel
		const infoIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(infoIndex, infoIndex + infoBufferSize);
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset);
		const nameIndex = bufferToInt(infoBuffer, friendlyNameIndexOffset);
		
		// create return object if needed
		if (deviceInfo.tx[nameNumber] == undefined) {
			deviceInfo.tx[nameNumber]={};
		}
		let returnChannel = deviceInfo.tx[nameNumber];
		returnChannel.number = nameNumber;
		
		// get name
		returnChannel.friendlyName = parseString(reply, nameIndex);
	}
    return deviceInfo;
}

const parseTxChannels = (reply) => {
	const deviceInfo = {};
	deviceInfo.tx = {};
	let firstChannelGroup;
	
	const channelCount = reply[10];
	const recCount = reply[11];
	const startIndex = 12;

// set offsets
	const infoBufferSize = 8;
	const nameNumberOffset = 0;
	const sampleRateOffset = 4;
	const nameIndexOffset = 6;
	
	// for each channel
	for (let i = 0; i < Math.min(recCount,32) ; i++) {
		// get info chunk of channel
		const infoIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(infoIndex, infoIndex + infoBufferSize);
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset);
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset);
		
		// create return object if needed
		if (deviceInfo.tx[nameNumber] == undefined) {
			deviceInfo.tx[nameNumber]={};
		}
		let returnChannel = deviceInfo.tx[nameNumber];
		returnChannel.number = nameNumber;
		
		// get name
		const channelName = parseString(reply, nameIndex);
		returnChannel.name = channelName;

		// get sampleRate
		const sampleRateIndex = bufferToInt(infoBuffer, sampleRateOffset);
		if (i == 0) {
			firstChannelGroup = sampleRateIndex;
		} else if (sampleRateIndex != firstChannelGroup) {
			deviceInfo.tx.count = i;
			break;
		}
		 returnChannel.sampleRate = reply.readUInt32BE(sampleRateIndex);
	}
    return deviceInfo;
}

const parseRxChannels = (reply) => {
	const deviceInfo = {};
	deviceInfo.rx = {};
	
	const channelCount = reply[10];
	const recCount = reply[11];
	const startIndex = 12;

// set offsets
	const infoBufferSize = 20;
	const nameNumberOffset = 0;
	const sampleRateOffset = 4;
	const nameIndexOffset = 10; 
	const sourceChannelOffset = 6;
	const sourceDeviceOffset = 8;
	const channelStatusOffset =  12;
	const subscriptionStatusOffset = 14;
	
	// for each channel
	for (let i = 0; i < Math.min(recCount,32) ; i++) {
		// get info chunk of channel
		const infoIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(infoIndex, infoIndex + infoBufferSize);
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset);
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset);
		
		// create return object if needed
		if (deviceInfo.rx[nameNumber] == undefined) {
			deviceInfo.rx[nameNumber]={};
		}
		let returnChannel = deviceInfo.rx[nameNumber];
		returnChannel.number = nameNumber;
		
		// get name
		const channelName = parseString(reply, nameIndex);
		returnChannel.name = channelName;
		
		// get routing
		const sourceChannelIndex = bufferToInt(infoBuffer, sourceChannelOffset);
		const sourceDeviceIndex = bufferToInt(infoBuffer, sourceDeviceOffset);
		const sampleRateIndex = bufferToInt(infoBuffer, sampleRateOffset);
		if (i == 0) {
			firstChannelGroup = sampleRateIndex;
		} else if (sampleRateIndex != firstChannelGroup) {
			deviceInfo.rx.count = i;
			break;
		}
		returnChannel.sourceChannel = parseString(reply, sourceChannelIndex);
		returnChannel.sourceDevice = parseString(reply, sourceDeviceIndex);
		returnChannel.channelStatus = bufferToInt(infoBuffer, channelStatusOffset);
		returnChannel.subscriptionStatus = bufferToInt(infoBuffer, subscriptionStatusOffset);
		returnChannel.sampleRate = reply.readUInt32BE(sampleRateIndex); 
	}
    return deviceInfo;
}

const parseDeviceInfo = (reply) => {
	const deviceInfo = {};
	
}

const parseDeviceName = (reply) => {
	return {name: parseString(reply, 10)};
}

const parseDeviceSettings = (reply) => {
	const deviceInfo = {};
	const recCount = reply[11];
	const startIndex = 12;
	const infoBufferSize = 4;
	
	for (let i = 0; i < recCount ; i++) {
		// get info chunk
		const infoIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(infoIndex, infoIndex + infoBufferSize);
		
		const infoCode = infoBuffer.readUInt16BE(0);
		const valueIndex = infoBuffer.readUInt16BE(2);

		switch (infoCode) {
			case 0x8020:
			// Sample rate
				deviceInfo.sr = reply.readUInt32BE(valueIndex);
				break;
				
			case 0x8301 : 
			// Latency 
				deviceInfo.latency = reply.readUInt32BE(valueIndex)/1000000; 
				break;
		}
	}
	return deviceInfo;
}


//**
//** Module API
//**




module.exports = {

	getChannelSubscriptionName: function (channel) {
		return channel?.friendlyName || channel?.name;
	},

	findDeviceIpByName: function (deviceName) {
		for (const [ip, device] of Object.entries(this.devicesData)) {
			if (device?.name == deviceName) {
				return ip;
			}
		}
	},

	findTxChannelByName: function (deviceIdentifier, channelName) {
		let device = this.devicesData[deviceIdentifier];
		if (!device) {
			const deviceIp = this.findDeviceIpByName(deviceIdentifier);
			device = this.devicesData[deviceIp];
		}
		if (!device?.tx) {
			return;
		}
		for (const [channelNumber, channel] of Object.entries(device.tx)) {
			if (!isNaN(channelNumber) && (channel?.name == channelName || channel?.friendlyName == channelName)) {
				return channel;
			}
		}
	},
	
	findRxChannelByName: function (deviceIdentifier, channelName) {
		let device = this.devicesData[deviceIdentifier];
		if (!device) {
			const deviceIp = this.findDeviceIpByName(deviceIdentifier);
			device = this.devicesData[deviceIp];
		}
		if (!device?.rx) {
			return;
		}
		for (const [channelNumber, channel] of Object.entries(device.rx)) {
			if (!isNaN(channelNumber) && (channel?.name == channelName)) {
				return channel;
			}
		}
	},
	
	checkConnections() {
		for (service of ['ARC', 'CMC', 'SETTINGS', 'HEARTBEAT']) {
			if (!this.activeConnections[service]) {
				if (this.CONNECTED) {
					this.CONNECTED = false;
					this.updateStatus(InstanceStatus.Disconnected);
				}
				return false;
			}
		}
		if (!this.CONNECTED) {
			this.CONNECTED = true;
			this.updateStatus(InstanceStatus.Ok);
		}
		return true
	},
	
		
	initConnection: function () {
		let self = this;
		this.counter = Buffer.from('0000', 'hex');

		this.debug = this.config.verbose;
		this.timeout = this.config.timeoutInterval;
		this.activeConnections = {};
		self.updateStatus(InstanceStatus.Connecting);
		
		// create data object
		self.devicesData = {};
		
		// create actions and feedback dropdown choices
		self.devicesChoices = [];
		self.txChannelsChoices = {};
		self.rxChannelsChoices = {};
		self.txFriendlyNameRefreshCounter = 0;

		// get available Ips
		const nets = networkInterfaces();
		let availableIps = [];
		let availableMacs = {};
		for (const name of Object.keys(nets)) {
			for (const net of nets[name]) { 
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        // 'IPv4' is in Node <= 17, from 18 it's a number 4 or 6
				const familyV4Value = (typeof net.family === 'string') ? 'IPv4' : 4
				if (net.family === familyV4Value && !net.internal) {
					availableIps.push(net.address);
					availableMacs[net.address] = net.mac;
				}
			}
		}
		
	// create communication sockets
		this.sockets = {};
		
		// create Dante ARC socket
		this.sockets.ARC = dgram.createSocket({type: "udp4" , reusePort: true, reuseAddr:true});
		const arcSocket = this.sockets.ARC;
		
       	arcSocket.on("message", this.parseReply.bind(this));
   		arcSocket.on("error", (error)=>{
			self.log('error','ARC socket : ', error.message);
			self.activeConnections.ARC = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
		
		arcSocket.on("close", ()=> {
			self.log('warn', 'ARC socket closed');
			self.activeConnections.ARC = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
		
        arcSocket.on("listening", ()=>{
			self.activeConnections.ARC = true;
			self.checkConnections();
		}); 
		
		// bind socket to random port of configured ip address if available
		if (availableIps.includes(self.config.ip)) {
			arcSocket.bind(0, self.config.ip);
			this.mac = Buffer.from(availableMacs[self.config.ip].replaceAll(':',''), 'hex'); 
		} else {
			this.log('warn', "Config IP not available");
			arcSocket.bind();
			this.mac = Buffer.from('000000000000', 'hex');
		}


		// create Dante settings socket
		this.sockets.SETTINGS = dgram.createSocket({type: "udp4", reusePort:true, reuseAddr: true});
		const settingSocket = this.sockets.SETTINGS;
		settingSocket.on("message", this.parseSettingsReply.bind(this));	
		
  		settingSocket.on("error", (error)=>{
			self.log('error', 'Settings socket : ', error.message);
			self.activeConnections.SETTINGS = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
		
		settingSocket.on("close", ()=> {
			self.log('warn', 'Settings socket closed');
			self.activeConnections.SETTINGS = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
 
		settingSocket.on ("listening", () => {  
			if (availableIps.includes(self.config.ip)) {
				settingSocket.addMembership(DANTE_CONST.MULTICAST_IP.INFO, self.config.ip);
			} else {
				settingSocket.addMembership(DANTE_CONST.MULTICAST_IP.INFO, );
			}
			self.activeConnections.SETTINGS = true;
			self.checkConnections();
		});
		
		if (availableIps.includes(self.config.ip)) {
			settingSocket.bind(DANTE_CONST.PORTS.INFO, self.config.ip);
		} else {
			settingSocket.bind(DANTE_CONST.PORTS.INFO);
		}
		

		// create Dante CMC socket
		this.sockets.CMC = dgram.createSocket({type: "udp4", reusePort:true, reuseAddr: true});
		const cmcSocket = this.sockets.CMC;
		cmcSocket.on("message", this.parseCmcReply.bind(this));	
		
  		cmcSocket.on("error", (error)=>{
			self.log('error', 'CMC socket : ', error.message);
			self.activeConnections.CMC = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
		
		cmcSocket.on("close", ()=> {
			self.log('warn', 'CMC socket closed');
			self.activeConnections.CMC = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
		
		cmcSocket.on("listening", ()=>{
			self.activeConnections.CMC = true;
			self.checkConnections();
		}); 
		
		if (availableIps.includes(self.config.ip)) {
			cmcSocket.bind({address: self.config.ip});
		} else {
			cmcSocket.bind();
		}
		
		
		// create Dante heartbeat socket
		this.sockets.HEARTBEAT = dgram.createSocket({type: "udp4", reusePort:true, reuseAddr: true});
		const heartbeatSocket = this.sockets.HEARTBEAT;
		heartbeatSocket.on("message", this.parseHeartbeatReply.bind(this));	
		
  		heartbeatSocket.on("error", (error)=>{
			self.log('error', 'Heartbeat socket : ', error.message);
			self.activeConnections.HEARTBEAT = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
		
		heartbeatSocket.on("close", ()=> {
			self.log('warn', 'Heartbeat socket closed');
			self.activeConnections.HEARTBEAT = false;
			if (self.CONNECTED) {
				self.updateStatus(InstanceStatus.Disconnected);
				self.CONNECTED = false;
			}
		});
		
		heartbeatSocket.on ("listening", () => {  
			if (availableIps.includes(self.config.ip)) {
				heartbeatSocket.addMembership(DANTE_CONST.MULTICAST_IP.HEARTBEAT, self.config.ip);
			} else {
				heartbeatSocket.addMembership(DANTE_CONST.MULTICAST_IP.HEARTBEAT, );
			}
			self.activeConnections.HEARTBEAT = true;
			self.checkConnections();
		});
		
		if (availableIps.includes(self.config.ip)) {
			heartbeatSocket.bind(DANTE_CONST.PORTS.HEARTBEAT, self.config.ip);
		} else {
			heartbeatSocket.bind(DANTE_CONST.PORTS.HEARTBEAT);
		}
		
		self.setupInterval(); 
		
		if (availableIps.includes(self.config.ip)) {
			self.mdns = multidns({interface: self.config.ip});
		} else {
			self.mdns = multidns();
		}
		self.mdns.on('response', self.dante_discovery.bind(this));
		

		// dante devices discover
		this.getMdnsServices();
	},
	
	
	// add device choice item for actions and feedbacks
	insertDeviceChoice: function (deviceIp, deviceName) {
		this.log('info', `INSERT DEVICE : ${deviceName}, ip : ${deviceIp}`);

		this.devicesChoices.push({id: deviceIp, label: deviceName});
		this.devicesChoices.sort((deviceA, deviceB) => {
				return deviceA.label.localeCompare(deviceB.label);
		});
	},
	
	// update device name in dropdown choice
	updateDeviceChoice: function (deviceIp, deviceName) {
		
		this.log('info', 'UPDATE DEVICE NAME : ' + deviceName);
		
		for (let device of this.devicesChoices) {
			if (device.id == deviceIp) {
			  if (device.label != deviceName) {
			    device.label=deviceName;
				this.devicesChoices.sort((deviceA, deviceB) => {
				  return deviceA.label.localeCompare(deviceB.label);
			    });
				this.updateData();
			  }
			  break;
			}
		}
		
		
	},
	
	
	
	// create or update channels name in dropdown choices for either rx or tx (channelType)
	updateChannelChoices: function(deviceIp, channelType) {
		
		if (!this.devicesData[deviceIp]?.[channelType]) {
			this.log('error', "ERROR : Can't update channelsChoices for device " + deviceIp);
			return;
		}
  
		let deviceName = this.devicesData[deviceIp].name;
		let ioObject = this.devicesData[deviceIp][channelType];
  
		let channelChoice = [{id: 0, label:'None'}];
		if (channelType == 'tx') {
			for (let i = 1; i<= ioObject.count; i++) {
				let channelName = this.getChannelSubscriptionName(ioObject[i]);
				channelChoice[i] = {id: i, label : channelName};
			}
		} else if (channelType == 'rx') {
			for (let i = 1; i<= ioObject.count; i++) {
				let indexString = i.toString().padStart(2,'0');
				let channelName = ioObject[i]?.name ?? '';
				channelChoice.push({id: i, label: channelName}); //indexString + (channelName ? ' : ' + channelName : '')});
			}
		}
		if (!this[channelType + 'ChannelsChoices'][deviceName]) {
			this[channelType+'ChannelsChoices'][deviceName] = channelChoice;
			this.updateData();
		} else {
			for (let i=1; i < channelChoice.length; i++) {
				if (!this[channelType + 'ChannelsChoices'][deviceName][i] || channelChoice[i].label != this[channelType + 'ChannelsChoices'][deviceName][i].label) {
					this[channelType+'ChannelsChoices'][deviceName] = channelChoice;
					this.updateData();
					break;
				}	
			}
		}
	},

// register dante device
	registerDevice : function (deviceIp, deviceName) {
		this.devicesData[deviceIp] = {name: deviceName, ports:{}};
		const currDevice = this.devicesData[deviceIp];
		
	// timeout function to destroy reference if device is offline too long
		if ((this.timeout > 0) && !currDevice.timeoutArray) {
			// embed timeout object into array to avoid circular references with merge function
			currDevice.timeoutArray = [setTimeout(() => {this.destroyDevice(deviceIp)}, this.timeout)];
		}
		
		this.insertDeviceChoice(deviceIp, deviceName);
		return currDevice;
	},	


// destroy device registration
	destroyDevice : function (deviceIp) {
		const deviceName = this.devicesData[deviceIp]?.name;
		this.log('warn', `${deviceName} (${deviceIp}) is offline. Destroying references`);
		
		// delete channels name choices
		for (const channelType of ['rx', 'tx']) {
			delete this[channelType+'ChannelsChoices'][deviceName];
		} 

		// delete device choice
		for (let i=0; i < this.devicesChoices.length; i++) {
			if (this.devicesChoices[i].id == deviceIp) {
				this.devicesChoices.splice(i, 1);
				break;
			}
		}
		
		//delete timeout
		clearTimeout(this.devicesData[deviceIp]?.timeoutArray?.[0]);
		
		// delete object from devicesData
		delete this.devicesData[deviceIp];

		this.updateData();
	},
	
	
// keep device from being considered offline
	keepAlive: function (deviceIp) {
		const toArray = this.devicesData[deviceIp]?.timeoutArray;
		if (toArray) {
			clearTimeout(toArray[0]);
			if (this.timeout > 0) {
				toArray[0] = setTimeout(() => {this.destroyDevice(deviceIp)}, this.timeout);
			}
		}
	},
			
	


// function handling incoming dante messages
    parseReply: function(reply, rinfo) {
		const self = this;
        const deviceIp = rinfo.address;
        const replySize = rinfo.size;
        let deviceData = {};
    	let updateFlags = [];

        if (this.debug) {
            // Log replies when in debug mode
            this.log('debug', `ARC : Rx (${reply.length}): ${reply.toString("hex")}`);
        }

          if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.CONTROL && replySize === bufferToInt(reply, 2)){
 
//			// network is alive
//			this.updateStatus(InstanceStatus.Ok);
//			this.CONNECTED = true;
//			
//			// device is online
//			this.keepAlive(deviceIp);

            const commandId = bufferToInt(reply, 6);
			
			deviceData[deviceIp] = {};

			switch (commandId) {
				
				// deviceName
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_NAME_QUERY :
					deviceData[deviceIp] = parseDeviceName(reply);
					let currDevice = deviceData[deviceIp];

					if (this.devicesData?.[deviceIp].name != currDevice.name) {
						this.updateDeviceChoice(deviceIp, currDevice.name);
						updateFlags.push('name');
					}
					
					
					break;
						
						
				// channelCount	
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_CHANNEL_COUNTS_QUERY: {
					deviceData[deviceIp] = parseChannelCount(reply);
					let currDevice = deviceData[deviceIp];
					
					// if channel count has changed, retrieve channel names
					if (currDevice.rx.count >0 && currDevice.rx.count != this.devicesData[deviceIp]?.rx?.count) {
						updateFlags.push('rxCount');
					}
					if (currDevice.tx.count >0 && currDevice.tx.count != this.devicesData[deviceIp]?.tx?.count) {
						updateFlags.push('txCount');
					}
					break;
				}
					
				// txChannels
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY : {
					deviceData[deviceIp] = parseTxChannels(reply);
					updateFlags.push('tx');
					break;
				}
							
				// txChannelFriendlyNames
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY: {
					deviceData[deviceIp] = parseTxFriendlyNames(reply);
					updateFlags.push('tx');
					break;
				}
					
				// rxChannels
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY: {
					deviceData[deviceIp] = parseRxChannels(reply);
					updateFlags.push('rx');
					break;
				}
					
				// device settings 
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_QUERY: {
					deviceData[deviceIp] = parseDeviceSettings(reply);
					updateFlags.push('info');
					break;
				}
			}
						
			
//			if (this.debug) {
//				// Log parsed device information when in debug mode
//				console.log('DEVICE DATA : ', deviceData);
//			}
			
			this.devicesData = merge(this.devicesData, deviceData);
			// update Channels choices for actions, feedbacks & variables
			
			for (const flag of updateFlags) {
				switch (flag) {
					case 'name' : 
						this.updateData();
						break;
					case 'info':
						this.checkVariables(deviceIp, 'sr', 'latency');
						break;
					case 'rx':
						this.checkVariables(deviceIp, 'rx', 'rx_names');
						this.updateChannelChoices(deviceIp, flag);
						this.checkFeedbacks();
						break;
					case 'tx':
						this.checkVariables(deviceIp, 'tx', 'tx_names');
						this.updateChannelChoices(deviceIp, flag);
						this.checkFeedbacks();
						break;
					case 'rxCount':
						this.getRxChannels(deviceIp);
						break;
					case 'txCount':
						this.getTxChannels(deviceIp);
						this.getTxChannelFriendlyNames(deviceIp);
						break;
				}
						
			}
        }
    },


// function handling HEARTBEAT messages
    parseHeartbeatReply: function(reply, rinfo) {
		const self = this;
        const deviceIp = rinfo.address;

        if (this.debug) {
            // Log replies when in debug mode
  //          this.log('debug', `HEARTBEAT : Rx (${reply.length}): ${reply.toString("hex")}`);
        }

          if ((bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.HEARTBEAT) && (rinfo.size === bufferToInt(reply, 2)) && (parseString(reply, 16) == 'Audinate')) {
 
			// network is alive
			if (!this.CONNECTED) {
				this.updateStatus(InstanceStatus.Ok);
				this.CONNECTED = true;
			}
			
			// device is online
			this.keepAlive(rinfo.address);
        }
    },



// function handling incoming dante setting messages (on settings port)
    parseSettingsReply: function(reply, rinfo) {
        const deviceIp = rinfo.address;
        const replySize = rinfo.size;
        let deviceData = {};
    	let updateFlags = [];

		if (this.debug) {
            // Log replies when in debug mode
            this.log('debug', `SETTINGS : Rx (${reply.length}): ${reply.toString("hex")}`);
        }

		if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.SETTINGS && replySize == bufferToInt(reply, 2)) {
		
			// network is alive
			if (!this.CONNECTED) {
				this.updateStatus(InstanceStatus.Ok);
				this.CONNECTED = true;
			}
			const payload = reply.slice(24);
               const commandId = bufferToInt(payload, 2);
               
			deviceData[deviceIp] = {};
			currDevice = deviceData[deviceIp];
			
			
			switch (commandId) {
				
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_ENCODING_STATUS : {
				// get encoding setting
					const enc = bufferToInt(payload, 12, 4);
					const encValue = DANTE_CONST.ENCODINGS[enc] ?? enc;
					currDevice.encoding = encValue;
				// mark flag to update variables
					if (this.devicesData[deviceIp]?.encoding != encValue) {
						updateFlags.push('encoding');
					}
				// get encoding options
					let optionsOffset = bufferToInt(payload, 8);
					const optionsNumber = bufferToInt(payload, 10);
					if (optionsNumber && optionsNumber > 0) {
						currDevice.encodingOptions = [];
						for (let i = 0; i < optionsNumber; i++) {
							currDevice.encodingOptions.push (bufferToInt(payload, optionsOffset, 4).toString());
							optionsOffset += 4;
						}
				// mark flag to update variables
						if (!updateFlags.includes('encodingOptions') && !compareArrays(currDevice.encodingOptions, this.devicesData[deviceIp]?.encodingOptions)) {
							updateFlags.push('encodingOptions');
						}
					}
					break;
				}
					
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_STATUS : {
				// get sample rate setting
					const sr = bufferToInt(payload, 12, 4);
					currDevice.sr = sr;
				// mark flag to update variables
					if (this.devicesData[deviceIp]?.sr != sr) {
						updateFlags.push('sr');
					}
				// get sample rate options
					let optionsOffset = bufferToInt(payload, 8);
					const optionsNumber = bufferToInt(payload, 10);
					if (optionsNumber && optionsNumber > 0) {
						currDevice.srOptions = [];
						for (let i = 0; i < optionsNumber; i++) {
							currDevice.srOptions.push(bufferToInt(payload, optionsOffset, 4).toString());
							optionsOffset += 4;
						}
				// mark flag to update variables
						if (!updateFlags.includes('srOptions') && !compareArrays(currDevice.srOptions, this.devicesData[deviceIp]?.srOptions)) {
							updateFlags.push('srOptions');
						}
					}
					break;
				}
							
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_PULLUP_STATUS : {
				// get pullup setting
					const pullup = bufferToInt(payload, 12, 4);
					currDevice.pullup = DANTE_CONST.PULLUPS[pullup];
					currDevice.pullup_string = parseString(payload, 32);
				// mark flag to update variables
					if (this.devicesData[deviceIp]?.pullup != pullup) {
						updateFlags.push('pullup');
					}
				// get pullup options
					let optionsOffset = bufferToInt(payload, 8);
					const optionsNumber = bufferToInt(payload, 10);
					if (optionsNumber && optionsNumber > 0) {
						currDevice.pullupOptions = [];
						for (let i = 0; i < optionsNumber; i++) {
							currDevice.pullupOptions.push(bufferToInt(payload, optionsOffset, 4).toString());
							optionsOffset += 4;
						}
				// mark flag to update variables
						if (!updateFlags.includes('pullupOptions') && !compareArrays(currDevice.pullupOptions, this.devicesData[deviceIp]?.pullupOptions)) {
							updateFlags.push('pullupOptions');
						}
					}
					break;
				}
				
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_STATUS : {
					// currently only handles AVIO 2out
					const channelCount = 2; 
					currDevice.output_levels = [];
					for (let i = 0; i < channelCount; i++) {
						const level = bufferToInt(payload, 24 + i*4, 4)
						currDevice.output_levels.push(DANTE_CONST.LEVELS[level] ?? level);
					// mark flag to update variables
						if (!updateFlags.includes('output_levels') && !compareArrays(currDevice.output_levels, this.devicesData[deviceIp]?.output_levels)) {
							updateFlags.push('output_levels');
						}
					}
					updateFlags.push('output_levels');
					break;
				}

				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_MANF_VERSIONS_STATUS : {
					currDevice.manfShortName = parseString(payload, 8);
					currDevice.manufacturer = parseString(payload, 52);
					currDevice.modelName = parseString(payload, 180);
					currDevice.softwareVersionMajor = bufferToInt(payload, 32, 1);
					currDevice.softwareVersionMinor = bufferToInt(payload, 33, 1);
					currDevice.softwareVersionPatch = bufferToInt(payload, 34, 2);
					currDevice.softwareVersionBuild = bufferToInt(payload, 44, 4);
					currDevice.productVersionMajor = bufferToInt(payload, 308, 1);
					currDevice.productVersionMinor = bufferToInt(payload, 309, 1);
					currDevice.productVersionPatch = bufferToInt(payload, 310, 2);
					currDevice.productVersionString = parseString(payload, 312); 
					updateFlags.push('manf');
					break;
				}
				
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_VERSIONS_STATUS : {
					currDevice.danteSoftwareVersionMajor = bufferToInt(payload, 8, 1);
					currDevice.danteSoftwareVersionMinor = bufferToInt(payload, 9, 1);
					currDevice.danteSoftwareVersionPatch = bufferToInt(payload, 10, 2);
					currDevice.danteSoftwareVersionBuild = bufferToInt(payload, 40, 4);
					currDevice.hardwareVersionMajor = bufferToInt(payload, 12, 1);
					currDevice.hardwareVersionMinor = bufferToInt(payload, 13, 1);
					currDevice.hardwareVersionPatch = bufferToInt(payload, 14, 2);
					currDevice.hardwareVersionBuild = bufferToInt(payload, 6, 1);
					currDevice.danteModel = parseString (payload, 64);
					break;
				}
				
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CHANGE : {
					this.getRxChannels(deviceIp);
					break;
				}
					
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_CHANGE : {
					this.getTxChannels(deviceIp); 
					this.getTxChannelFriendlyNames(deviceIp); 
					break;
				}
					
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_LABEL_CHANGE : {
					this.getTxChannelFriendlyNames(deviceIp);
					break;
				}
				
				case DANTE_CONST.COMMANDS.MESSAGE_TYPE_PROPERTY_CHANGE : {
					this.getSettings(deviceIp);
					break;
				}
					
			}
			
			this.devicesData = merge(this.devicesData, deviceData); this.checkVariables(deviceIp);
			this.checkVariables(deviceIp, ...updateFlags);

			for (const flag of updateFlags) {
				if (flag.slice(-7) == 'Options') {
					this.initActions()
				break;
				}
			}
		}
	},
	
	
// function handling incoming dante cmc messages (on cmc port)
	parseCmcReply : function (reply, rinfo) {
        const deviceIp = rinfo.address;
        const replySize = rinfo.size;
        let deviceData = {};

		if (this.debug) {
            // Log replies when in debug mode
            this.log('debug', `CMC : Rx Info(${reply.length}): ${reply.toString("hex")}`);
        }

		if (bufferToInt(reply, 0) == DANTE_CONST.PROTOCOL.CMC && replySize == bufferToInt(reply,2)) {
			const commandId = bufferToInt(reply, 6);
			deviceData[deviceIp] = {};
			currDevice = deviceData[deviceIp];
			
			switch (commandId) {
				case 0x1001 : {
					currDevice.ports = {SETTINGS: bufferToInt(reply, 28)};
					
					const deviceId = this.devicesData[deviceIp]?.name ?? deviceIp;
					this.log('info', `Port for service SETTINGS of device ${deviceId} is : ${bufferToInt(reply, 28)}`);

					this.devicesData = merge(this.devicesData, deviceData); 
					this.checkVariables(deviceIp); 
					this.refreshSettings(deviceIp);
					break;
				}
			}
			
			this.checkVariables();
		}
	},
	
	

// send dante command to the correct port, according to service id
    sendCommand(command, host, service = "ARC", forcePort) {
        if (this.debug) {
            // Log sent bytes when in debug mode
            this.log('debug', `${service} : Tx (${command.length}): ${command.toString("hex")}`);
        }
		
		// find port
//		if (!port) {
//			if (!this.devicesData[host]?.ports) { 
//				port = DANTE_CONST.PORTS[service];
//			} else {
//				port = this.devicesData[host].ports[service] ?? DANTE_CONST.PORTS[service];
//			}
//		}

		const port = forcePort ?? this.devicesData?.[host]?.ports?.[service];
		if (port) {	
			this.sockets[service]?.send(command, 0, command.length, port, host); 
		} else {
			const deviceId = this.devicesData[host]?.name ?? host;
			this.log('error', `Undefined port for service ${service} for device ${deviceId}`); return;
		}
    },



	
// create Dante message
    makeCommand(commandType, commandArguments = Buffer.alloc(2)) {

        const requestFlag = Buffer.from([0x00, 0x00]);
        const commandLength = intToBuffer(commandArguments.length + 11);

		const payload = Buffer.concat([
			intToBuffer(DANTE_CONST.PROTOCOL.CONTROL),
            commandLength,
            this.counter,
            intToBuffer(commandType),
            requestFlag,
            commandArguments,
			Buffer.from([0x00])
        ]);

		incrementBE(this.counter);

        return payload;
    },


	makeSettingCommand(commandType, commandArguments = Buffer.alloc(2)) {
		let commandLength = intToBuffer(commandArguments.length + 28);
		const startBlock = Buffer.from('2a84', "hex");

		const payload = Buffer.concat([
			intToBuffer(DANTE_CONST.PROTOCOL.SETTINGS),
			commandLength,
			this.counter,
			startBlock,
			this.mac,
			Buffer.from('0000', 'hex'),
			DANTE_CONST.AUDINATE_BUFFER,
			intToBuffer(commandType),
			commandArguments
		]);
			
		incrementBE(this.counter);

		return payload;
	},

//**
//** Specific Dante messages
//**

    resetDeviceName(ipaddress) {
        const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.setDeviceName);
        this.sendCommand(commandBuffer, ipaddress);
    },

    setDeviceName(ipaddress, name) {
        const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.setDeviceName, Buffer.from(name, "ascii"));
        this.sendCommand(commandBuffer, ipaddress);
    },

    setChannelName(ipaddress, channelName = "", channelType = "rx", channelNumber = 0) {
        const channelNameBuffer = Buffer.from(channelName, "ascii");
        let commandBuffer = Buffer.alloc(1);
        let channelNumberBuffer = intToBuffer(channelNumber); 

        if (channelType === "rx") {
            const commandArguments = Buffer.concat([
                Buffer.from("0401", "hex"),
                channelNumberBuffer,
                Buffer.from("001c", "hex"),
                Buffer.alloc(12),
                channelNameBuffer,
            ]);
            commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CONTROL, commandArguments);
        } else if (channelType === "tx") {
            const commandArguments = Buffer.concat([
                Buffer.from("040100000", "hex"),
                channelNumberBuffer,
                Buffer.from("0024", "hex"),
                Buffer.alloc(18),
                channelNameBuffer,
            ]);
            commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_NAMES_CONTROL, commandArguments);
        } else {
            throw "Invalid Channel Type - must be 'tx' or 'rx'";
        }
        this.sendCommand(commandBuffer, ipaddress);
    },
	
   setRxChannelName(ipaddress, channelNumber, channelName = "") {
        const channelNameBuffer = Buffer.from(channelName, "ascii");
        let commandBuffer = Buffer.alloc(1);
        let channelNumberBuffer = intToBuffer(channelNumber); 

        const commandArguments = Buffer.concat([
            Buffer.from("0401", "hex"),
            channelNumberBuffer,
            Buffer.from("001c", "hex"),
            Buffer.alloc(12),
            channelNameBuffer,
        ]);
        commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_CONTROL, commandArguments);
        this.sendCommand(commandBuffer, ipaddress);
    },

    setTxChannelName(ipaddress, channelNumber, channelName = "") {
        const channelNameBuffer = Buffer.from(channelName, "ascii");
        let commandBuffer = Buffer.alloc(1);
        let channelNumberBuffer = intToBuffer(channelNumber); 

        const commandArguments = Buffer.concat([
            Buffer.from("040100000", "hex"),
            channelNumberBuffer,
            Buffer.from("0024", "hex"),
            Buffer.alloc(18),
            channelNameBuffer,
        ]);
        commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_NAMES_CONTROL, commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
    },

    resetChannelName(ipaddress, channelType = "rx", channelNumber = 0) {
        this.setChannelName(ipaddress, "", channelType, channelNumber);
    },

    resetRxChannelName(ipaddress, channelNumber = 0) {
        this.setRxChannelName(ipaddress, channelNumber);
    },
	
    resetTxChannelName(ipaddress, channelNumber = 0) {
        this.setTxChannelName(ipaddress, channelNumber);
    },



    makeCrosspoint(destinationDevice, sourceChannelName, sourceDeviceName, destinationChannel) {
	
		const sourceChannel = this.findTxChannelByName(sourceDeviceName, sourceChannelName);
		const sourceSubscriptionName = this.getChannelSubscriptionName(sourceChannel) || sourceChannelName;
        const sourceChannelNameBuffer = Buffer.from(sourceSubscriptionName, "ascii");
        const sourceDeviceNameBuffer = Buffer.from(sourceDeviceName, "ascii");

		const destinationChannelNumber = this.findRxChannelByName(destinationDevice, destinationChannel)?.number ?? destinationChannel
	
		// Check if destinationDevice is an IP or a name
		const IP = RegExp(Regex.IP.slice(1,-1));
		const ipaddress = IP.test(destinationDevice) ? destinationDevice : this.findDeviceIpByName(destinationDevice);
		
		if (!ipaddress) {
			this.log('error', "Can't find " + DestinationDevice + " IP address");
			return;
		}
			

        let commandArguments = Buffer.concat([
			Buffer.from('0001', 'hex'), 						// unknown code
			intToBuffer (destinationChannelNumber),				// destination channel number
			intToBuffer (22), 									// Byte index of source channel Name
			intToBuffer(22 + sourceChannelNameBuffer.length+1), // Byte index of source device name
			Buffer.alloc(4),									// padding until byte index of source channel name
			sourceChannelNameBuffer,							// source channel Name
			Buffer.alloc(1),									// separator (\x00)
			sourceDeviceNameBuffer,								// source device name
        ]);

        const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.subscription, commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
		
		// get updated routing for feedback
//		this.getRxChannels(ipaddress);
    },
	
	

    clearCrosspoint(destinationDevice, destinationChannel) {
		
		const destinationChannelNumber = this.findRxChannelByName(destinationDevice, destinationChannel)?.number ?? destinationChannel

		// Check if destinationDevice is an IP or a name
		const IP = RegExp(Regex.IP.slice(1,-1));
		const ipaddress = IP.test(destinationDevice) ? destinationDevice : this.findDeviceIpByName(destinationDevice);
		
		if (!ipaddress) {
			this.log('error', "Can't find " + destinationDevice + " IP address");
			return;
		}
		
        let commandArguments = Buffer.concat([
            Buffer.from("0401", "hex"),
            intToBuffer(destinationChannelNumber),
            Buffer.from("005c006d", "hex"),
            Buffer.alloc(1),
        ]);

        const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.subscription, commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
    },



    getChannelCount(ipaddress) {
        const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.channelCount);
        this.sendCommand(commandBuffer, ipaddress);

        return this.devicesData[ipaddress]?.channelCount;
    },

	getTxChannelFriendlyNames(ipaddress) {
		if (!this.devicesData[ipaddress]) { 
			return
		}
		// clear registered friendly names
		for (let i = 1; i<= this.devicesData[ipaddress].tx?.count; i++) {
			const channel = this.devicesData[ipaddress]?.tx?.[i];
			if (channel) {
				delete channel.friendlyName;
			}
		}
		let commandArguments = Buffer.from("0001000100", "hex");
		for (let page = 0; page <= Math.ceil(this.devicesData[ipaddress]?.tx?.count/32); page++ ) {
			commandArguments.writeUInt8(page*32+1, 3);
			const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY, commandArguments);
			this.sendCommand(commandBuffer, ipaddress); 
		}
	},
	
	getTxChannels (ipaddress) {
		let commandArguments = Buffer.from("0001000100", "hex");
		for (let page = 0; page <= Math.ceil(this.devicesData[ipaddress]?.tx?.count/32); page++ ) {
			commandArguments.writeUInt8(page*32+1, 3);
			const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_TX_CHANNEL_QUERY, commandArguments);
			this.sendCommand(commandBuffer, ipaddress);
		}
	},
	
	getRxChannels (ipaddress) {
		let commandArguments = Buffer.from("0001000100", "hex");
		for (let page = 0; page <= this.devicesData[ipaddress]?.tx?.count/16; page++ ) {
			commandArguments.writeUInt8(page*16+1, 3);
			const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_RX_CHANNEL_QUERY, commandArguments);
			this.sendCommand(commandBuffer, ipaddress);
		}
	},

	getDeviceName(ipaddress) {
		const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_NAME_QUERY);
		this.sendCommand(commandBuffer, ipaddress);
	},
	
	getSettings(ipaddress) {
		const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_QUERY)
		this.sendCommand(commandBuffer, ipaddress);
	},
	
	
	setLatency(ipaddress, latency) {
		let commandArguments = Buffer.from("050382050020021100108301002400000000000000000000000000000000", "hex");
		commandArguments.writeUInt32BE(latency*1000000,22);
		commandArguments.writeUInt32BE(latency*1000000,26);
		const commandBuffer = this.makeCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_DEVICE_SETTINGS_CONTROL, commandArguments)
		this.sendCommand(commandBuffer, ipaddress);
	},

	setSampleRate(ipaddress, sampleRate) {
		const flag = intToBuffer(sampleRate > 0 ? 1 : 0, 4);
		const arguments = Buffer.concat ([
			Buffer.from ('00000064', 'hex'),
			flag,
			intToBuffer(sampleRate, 4)
			]);
		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_CONTROL, arguments); 
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},	
	
	getSampleRate (ipaddress) {
		this.setSampleRate(ipaddress, 0)
	},
	
	setPullup (ipaddress, pullup) {
		const flag = intToBuffer(3, 4);
		const arguments = Buffer.concat ([
			Buffer.from ('00000064', 'hex'),
			flag,
			intToBuffer(pullup, 4),
			intToBuffer(0, 2)
			]);
		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_PULLUP_CONTROL, arguments); 
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},
	
	getPullup (ipaddress) {
		const flag = intToBuffer(0, 4);
		const arguments = Buffer.concat ([
			Buffer.from ('00000064', 'hex'),
			flag,
			intToBuffer(0, 4)
			]);
		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_PULLUP_CONTROL, arguments); 
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},
	
	setEncoding(ipaddress, encoding) {
		const flag = intToBuffer(encoding >0 ? 1 : 0, 4);
		const arguments = Buffer.concat ([
			Buffer.from ('00000064', 'hex'),
			flag,
			intToBuffer(encoding, 4)
			]);

		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_ENCODING_CONTROL, arguments); 
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},

	getEncoding(ipaddress) {
		this.setEncoding(ipaddress, 0);
	},

	setLevel(ipaddress, direction= 'out', channelNumber, levelSetting) {
		const arguments = Buffer.concat ([
			Buffer.from('00000000', 'hex'),
			Buffer.from('00010001', 'hex'),
			Buffer.from('000c0010', 'hex'),
			Buffer.from('02010000', 'hex'),
			intToBuffer(channelNumber, 4),
			intToBuffer(levelSetting, 4)
		]);
		
		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_CONTROL, arguments);
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},
	
	getLevel(ipaddress) {
		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_CODEC_CONTROL, intToBuffer(0, 4));
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},

	getManfVersion(ipaddress) {
		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_MANF_VERSIONS_QUERY, intToBuffer(0, 4));
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},
	
	getVersion(ipaddress) {
		const commandBuffer = this.makeSettingCommand(DANTE_CONST.COMMANDS.MESSAGE_TYPE_VERSIONS_QUERY, intToBuffer(0, 4));
		this.sendCommand(commandBuffer, ipaddress, 'SETTINGS');
	},

	getSettingsPort (ipaddress) { 
		const commandBuffer = Buffer.concat([
			intToBuffer(0x1200, 2),
			intToBuffer(20), // command size
			this.counter,
			intToBuffer(0x1001),
			intToBuffer(0000),
			intToBuffer(0x3520),
			this.mac,
			intToBuffer(0x0000)
			]);			

		this.sendCommand(commandBuffer, ipaddress, 'CMC');
		
		incrementBE(this.counter);
	},
	
	
	
	dante_discovery: function(response, rinfo) { 
		for (type of ['answers', 'additionals']) {
			response[type]?.forEach((answer) => {
				const name = answer.name;
				// get devices and services names and port
				if (answer.type == 'PTR' && DANTE_CONST.SERVICES_ARRAY.includes(name)) { 
					this.mdns.query({
						questions:[{
							name: answer.data,
							type:'SRV',
						}]
					}); 
				} else if (answer.type == 'SRV') {
					// register services and port
					for ([id, danteService] of Object.entries(DANTE_CONST.SERVICES)) { 
						const dotIndex = name.indexOf('.');
						const deviceName = name.slice(0, dotIndex);
						const serviceName = name.slice(dotIndex + 1);

						if (serviceName == danteService) { 
							const deviceIp = rinfo.address;
							let currDevice = this.devicesData[deviceIp];
							
							if (currDevice) {
								this.keepAlive(deviceIp);
							} else {
						// create data object if needed
								currDevice = this.registerDevice(deviceIp, deviceName);				
								this.updateData();
							}
							
							if (currDevice.name != deviceName) {
								currDevice.name = deviceName;
								this.updateDeviceChoice(deviceIp, deviceName); 
								this.updateData();
							}
							if (!currDevice.ports) {
								currDevice.ports = {};
							}
							
							if (currDevice.ports[id] != answer.data.port) { 
		
								this.log('info', `Port for service ${id} of device ${deviceName} is : ${answer.data.port}`);						
								currDevice.ports[id] = answer.data.port;
								
								switch (id) {
									case 'ARC' : 
										this.getChannelCount(deviceIp);
										this.getSettings(deviceIp);
										break;
										
									case 'CMC' :
										this.getSettingsPort(deviceIp);
									break;
								}
							}
						}
					}
				}	
			});
		} 
	},
	
	
	
	setupInterval: function() {
		let self = this;
	
		self.stopInterval();
	
		if (self.config.interval > 0) {
			self.INTERVAL = setInterval(self.getMdnsServices.bind(self), self.config.interval);
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
	
	refreshSettings: function(deviceIp) {
		const ipArray = deviceIp ? [deviceIp] : Object.keys(this.devicesData);
		for (ip of ipArray) {
			this.getSampleRate(ip);
			this.getPullup(ip);
			this.getEncoding(ip);
			this.getLevel(ip);
			this.getVersion(ip);
			this.getManfVersion(ip);
		}
	},
	
	refreshArc:  function(deviceIp) {
		const ipArray = deviceIp ? [deviceIp] : Object.keys(this.devicesData);
		for (ip of ipArray) {
			this.getDeviceName(ip);
			this.getSettings(ip);
			this.getRxChannels(ip);
			this.getTxChannels(ip);
			this.getTxChannelFriendlyNames(ip);
		}
	},
	
	getMdnsServices: async function () {

		if (this.debug) {
		this.log('debug', 'Mdns discovery');
		}
		
		let questions = []; 
		for (service of DANTE_CONST.SERVICES_ARRAY) {
			questions.push ({
				name: service, 
				type: 'PTR',
			});
		}
		
		this.mdns?.query({
			questions: questions
		});

	},
	
	updateData: function (bytes) {
		let self = this;
	
		//do more stuff
		this.initActions();
		this.initVariables();
		this.checkVariables();
		this.initFeedbacks();
		this.checkFeedbacks();
	},
}
