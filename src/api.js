const multidns = require('multicast-dns');
const dgram = require("dgram");
const merge = require("./utils/merge");
const { networkInterfaces } = require('os');
const { InstanceStatus, Regex } = require('@companion-module/base')
const {AUDINATE_BUFFER, DANTE_PORTS, DANTE_PROTOCOL, DANTE_COMMANDS, DANTE_MULTICAST_IP, DANTE_ENCODING_CHOICES} = require("./const")


const danteServiceTypes = ["_netaudio-cmc._udp", "_netaudio-dbc._udp", "_netaudio-arc._udp", "_netaudio-chan._udp"];
const danteControlPort = 4440;
const sequenceId1 = Buffer.from([0x29]);
const danteConstant = Buffer.from([0x27]);




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
  return buffer.toString('utf8', startIndex, end);
};

const findLabel = (choices, id) => {
	let result;
	choices.forEach((entry) => {
		if (entry.id == id) {
			result = entry.label;
		}
	})
	return result;
};

const findId = (choices, label) => {
	let result;
	choices.forEach((entry) => {
		if (entry.label == label) {
			result = entry.id
		}
	})
	return result;
};



//** 
//** Dante messages parsing
//**

const parseChannelCount = (reply) => {
    const deviceInfo = { tx: {count: reply[13]}, rx :{count:reply[15]} };
    return deviceInfo;
};


const parseChannelNames = (reply, infoType) => {
	const deviceInfo = {};
	let channelType = infoType.slice(0,2);
	deviceInfo[channelType] = {};
	let firstChannelGroup;
	
	const channelCount = reply[10];
	const recCount = reply[11];
	const startIndex = 12;

	const sourceChannelOffset = 6;
	const sourceDeviceOffset = 8;
	const channelStatusOffset =  12;
	const subscriptionStatusOffset = 14;
	let  infoBufferSize, nameNumberOffset, nameIndexOffset, sampleRateOffset;

// set indices for rx or tx
	if (infoType == 'tx') {
		infoBufferSize = 6;
		nameNumberOffset = 2;
		nameIndexOffset = 4;
	} else if (infoType == 'txInfo') {
	  infoBufferSize = 8;
	  nameNumberOffset = 0;
	  sampleRateOffset = 4;
	  nameIndexOffset = 6;
	}
	else if (infoType == 'rx') {
		infoBufferSize = 20;
		nameNumberOffset = 0;
		sampleRateOffset = 4;
		nameIndexOffset = 10;
	} 
	
	// for each channel
	for (let i = 0; i < Math.min(recCount,32) ; i++) {
		// get info chunk of channel
		const infoIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(infoIndex, infoIndex + infoBufferSize);
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset);
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset);
		
		// create return object if needed
		if (deviceInfo[channelType][nameNumber] == undefined) {
			deviceInfo[channelType][nameNumber]={};
		}
		let returnChannel = deviceInfo[channelType][nameNumber];
		returnChannel.number = nameNumber;
		
		// get name
		const channelName = parseString(reply, nameIndex);
		if (infoType == 'tx') {
			returnChannel.friendlyName = channelName;
		} else {
			returnChannel.name = channelName;
		}
		
		// get routing
		if (infoType == 'rx') {
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
		else if (infoType == 'txInfo') {
		  const sampleRateIndex = bufferToInt(infoBuffer, sampleRateOffset);
		  if (i == 0) {
				firstChannelGroup = sampleRateIndex;
			} else if (sampleRateIndex != firstChannelGroup) {
				deviceInfo.tx.count = i;
				break;
			}
		  returnChannel.sampleRate = reply.readUInt32BE(sampleRateIndex);
		}
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

const parseSettings = {
	MESSAGE_TYPE_SAMPLE_RATE_STATUS : function (payload) {
		const deviceInfo = {};
		deviceInfo.sr = bufferToInt
	}
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
	
		
	initConnection: function () {
		let self = this;
		this.counter = Buffer.from('0000', 'hex');
		
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
		
		
		// create Dante communication udp socket
		this.socket = dgram.createSocket({type: "udp4" , reusePort: true});

       	this.socket.on("message", this.parseReply.bind(this));
   		this.socket.on("error", (error)=>{
			self.log('error', error.message);
		});
		
        this.socket.on("listening", ()=>{self.updateStatus(InstanceStatus.Connecting);}); 
		
		// bind socket to random port of configured ip address if available
		if (availableIps.includes(self.config.ip)) {
			this.socket.bind(0, self.config.ip);
			this.mac = Buffer.from(availableMacs[self.config.ip].replaceAll(':',''), 'hex');
		} else {
			this.log('warn', "Config IP not available");
			this.socket.bind();
			this.mac = Buffer.from('000000000000', 'hex');
		}

		// create Dante settings socket
		this.settingSocket = dgram.createSocket({type: "udp4", reusePort:true, reuseAddr: true});
		
		this.settingSocket.on("message", this.parseSettingsReply.bind(this));	

		this.settingSocket.on ("listening", () => {  
			if (availableIps.includes(self.config.ip)) {
				self.settingSocket.addMembership(DANTE_MULTICAST_IP.INFO, self.config.ip);
			} else {
				self.settingSocket.addMembership(DANTE_MULTICAST_IP.INFO, );
			}
		});
		
		if (availableIps.includes(self.config.ip)) {
			this.settingSocket.bind(DANTE_PORTS.INFO, self.config.ip);
		} else {
			this.settingSocket.bind(DANTE_PORTS.INFO, );
		}

		

		this.debug = this.config.verbose;
		this.timeout = this.config.timeoutInterval;
		
		// create data object
		self.devicesData = {};
		
		// create actions and feedback dropdown choices
		self.devicesChoices = [];
		self.txChannelsChoices = {};
		self.rxChannelsChoices = {};
		self.txFriendlyNameRefreshCounter = 0;



		self.setupInterval(); 
		if (availableIps.includes(self.config.ip)) {
			self.mdns = multidns({interface: self.config.ip});
		} else {
			self.mdns = multidns();
		}
		self.mdns.on('response', self.dante_discovery.bind(this));
		

		// dante devices discover
		self.mdns?.query({
			questions:[{
				name:'_netaudio-arc._udp.local',
				type:'PTR'
			}]
		});
	},
	
	
	// add device choice item for actions and feedbacks
	insertDeviceChoice: function (deviceIp, deviceName) {
		this.log('info', 'INSERT DEVICE : ' + deviceName);

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

		if (!(this.devicesData[deviceIp] && this.devicesData[deviceIp][channelType])) {
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



// destroy device registration
	destroyDevice : function (deviceIp) {
		const deviceName = this.devicesData[deviceIp]?.name;
		this.log('warn', `${deviceName} is offline. Destroying references`);
		
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
            this.log('debug', `Rx (${reply.length}): ${reply.toString("hex")}`);
        }

        if (reply[0] === danteConstant[0]) { //&& reply[1] === sequenceId1[0]) {
		//if (reply[0] === DANTE_PROTOCOL.CONTROL[0]) {
		//if (bufferToInt(reply, 0, 1) == Math.floor(DANTE_PROTOCOL.CONTROL/256)) {
            if (replySize === bufferToInt(reply.slice(2, 4))) {
				// network is alive
				this.updateStatus(InstanceStatus.Ok);
				this.CONNECTED = true;
				
				// device is online
				this.keepAlive(deviceIp);
                const commandId = reply.slice(6, 8);
				
				// device is online
				this.keepAlive(deviceIp);
                
				deviceData[deviceIp] = {};

				switch (bufferToInt(commandId)) {
					
					// deviceName
					case 0x1002:
						deviceData[deviceIp] = parseDeviceName(reply);
						
						// create or update devices choices for actions if necessary
						if (!this.devicesData[deviceIp]?.name) {
							this.insertDeviceChoice(deviceIp, deviceData[deviceIp].name);
							
						// timeout function to destroy reference if device is offline too long
							if (this.timeout > 0) {
								// embed timeout object into array to avoid circular references with merge function
								deviceData[deviceIp].timeoutArray = [];
								const timeoutArray = deviceData[deviceIp].timeoutArray;
								timeoutArray[0] = setTimeout(() => {this.destroyDevice(deviceIp)}, this.timeout);
							}							

						// retrieve channel count and settings
							this.getChannelCount(deviceIp);
							this.getSettings(deviceIp);
							
						} else if (this.devicesData[deviceIp].name != deviceData[deviceIp].name) {
							this.updateDeviceChoice(deviceIp, deviceData[deviceIp].name);
							updateFlags.push('name');
						}
						
						
						break;
							
							
					// channelCount	
					case 0x1000:
						deviceData[deviceIp] = parseChannelCount(reply);
						
						// if channel count has changed, retrieve channel names
						if (deviceData[deviceIp].rx.count != this.devicesData[deviceIp]?.rx?.count) {
							this.getChannelNames(deviceIp, 'rx'); 
						}
						if (deviceData[deviceIp].tx.count != this.devicesData[deviceIp]?.tx?.count) {
							this.getChannelNames(deviceIp, 'txInfo', 'tx');
						}
						break;
						
					// txChannelInfo
					case 0x2000 :
						deviceData[deviceIp] = parseChannelNames(reply,'txInfo');
						updateFlags.push('tx');
						break;
								
					// txChannelNames
					case 0x2010:
					    deviceData[deviceIp] = parseChannelNames(reply,'tx');
						updateFlags.push('tx');
						break;
						
					// rxChannelNames
					case 0x3000:
						deviceData[deviceIp] = parseChannelNames(reply,'rx');
						updateFlags.push('rx');
						break;
						
					// device settings 
					case 0x1100:
						deviceData[deviceIp] = parseDeviceSettings(reply);
						updateFlags.push('info');
						break;
							
									
				}
							
				
				if (this.debug) {
					// Log parsed device information when in debug mode
					console.log('DEVICE DATA : ', deviceData);
				}
				
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
					}
							
				}
            }
        }
    },



// function handling incoming dante setting messages (on info port)
    parseSettingsReply: function(reply, rinfo) {
		const self = this;
        const deviceIp = rinfo.address;
        const replySize = rinfo.size;
        let deviceData = {};
    	let updateFlags = [];

		if (this.debug) {
            // Log replies when in debug mode
            this.log('debug', `Rx Info(${reply.length}): ${reply.toString("hex")}`);
        }

		if (bufferToInt(reply, 0) == DANTE_PROTOCOL.SETTINGS) {
            if (replySize == bufferToInt(reply.slice(2, 4))) {
				// network is alive
				this.updateStatus(InstanceStatus.Ok);
				this.CONNECTED = true;
				
				// device is online
				this.keepAlive(deviceIp);
				
				const payload = reply.slice(24);
                const commandId = bufferToInt(payload, 2);

				// device is online
				this.keepAlive(deviceIp);
                
				deviceData[deviceIp] = {};
				
				switch (commandId) {
					
					case DANTE_COMMANDS.MESSAGE_TYPE_ENCODING_STATUS : {
					// get encoding setting
						const enc = bufferToInt(payload, 12, 4);
						deviceData[deviceIp].encoding = findLabel(DANTE_ENCODING_CHOICES, enc) ?? enc;
					// get encoding options
						let optionsOffset = bufferToInt(payload, 8);
						const optionsNumber = bufferToInt(payload, 10);
						if (optionsNumber && optionsNumber > 0) {
							deviceData[deviceIp].encodingOptions = [];
							for (let i = 0; i < optionsNumber; i++) {
								deviceData[deviceIp].encodingOptions.push (bufferToInt(payload, optionsOffset, 4));
								optionsOffset += 4;
							}
						}
						break;
					}
						
					case DANTE_COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_STATUS : {
					// get encoding setting
						deviceData[deviceIp].sr = bufferToInt(payload, 12, 4);
					// get encoding options
						let optionsOffset = bufferToInt(payload, 8);
						const optionsNumber = bufferToInt(payload, 10);
						if (optionsNumber && optionsNumber > 0) {
							deviceData[deviceIp].srOptions = [];
							for (let i = 0; i < optionsNumber; i++) {
								deviceData[deviceIp].srOptions.push (bufferToInt(payload, optionsOffset, 4));
								optionsOffset += 4;
							}
						}
						break;
					}
					
						
					case DANTE_COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_PULLUP_STATUS : {
					// get encoding setting
						deviceData[deviceIp].pullup = bufferToInt(payload, 12, 4);
						deviceData[deviceIp].pullup_string = parseString(payload, 32);
					// get encoding options
						let optionsOffset = bufferToInt(payload, 8);
						const optionsNumber = bufferToInt(payload, 10);
						if (optionsNumber && optionsNumber > 0) {
							deviceData[deviceIp].pullupOptions = [];
							for (let i = 0; i < optionsNumber; i++) {
								deviceData[deviceIp].srOptions.push (bufferToInt(payload, optionsOffset, 4));
								optionsOffset += 4;
							}
						}
						break;
					}
	
				}
				
				this.devicesData = merge(this.devicesData, deviceData); this.checkVariables(deviceIp);
				//console.log(this.devicesData[deviceIp].encoding);
			}
		}
	},

		


    sendCommand(command, host, port = DANTE_PORTS.ARC) {
        if (this.debug) {
            // Log sent bytes when in debug mode
            this.log('debug', `Tx (${command.length}): ${command.toString("hex")}`);
        }

        this.socket.send(command, 0, command.length, port, host);
    },

	
	
// create Dante message
    makeCommand(commandType, commandArguments = Buffer.alloc(2)) {

        const padding = Buffer.from([0x00, 0x00]);
        let commandLength = intToBuffer(commandArguments.length + 11);

		const payload = Buffer.concat([
			intToBuffer(DANTE_PROTOCOL.CONTROL),
            commandLength,
            this.counter,
            intToBuffer(commandType),
            padding,
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
			intToBuffer(DANTE_PROTOCOL.SETTINGS),
			commandLength,
			this.counter,
			startBlock,
			this.mac,
			Buffer.from('0000', 'hex'),
			AUDINATE_BUFFER,
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
        const commandBuffer = this.makeCommand(DANTE_COMMANDS.setDeviceName);
        this.sendCommand(commandBuffer, ipaddress);
    },

    setDeviceName(ipaddress, name) {
        const commandBuffer = this.makeCommand(DANTE_COMMANDS.setDeviceName, Buffer.from(name, "ascii"));
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
            commandBuffer = this.makeCommand(DANTE_COMMANDS.setRxChannelName, commandArguments);
        } else if (channelType === "tx") {
            const commandArguments = Buffer.concat([
                Buffer.from("040100000", "hex"),
                channelNumberBuffer,
                Buffer.from("0024", "hex"),
                Buffer.alloc(18),
                channelNameBuffer,
            ]);
            commandBuffer = this.makeCommand(DANTE_COMMANDS.setTxChannelName, commandArguments);
        } else {
            throw "Invalid Channel Type - must be 'tx' or 'rx'";
        }
        this.sendCommand(commandBuffer, ipaddress);
    },



    resetChannelName(ipaddress, channelType = "rx", channelNumber = 0) {
        this.setChannelName(ipaddress, "", channelType, channelNumber);
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

        const commandBuffer = this.makeCommand(DANTE_COMMANDS.subscription, commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
		
		// get updated routing for feedback
		this.getChannelNames(ipaddress, 'rx');
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

        const commandBuffer = this.makeCommand(DANTE_COMMANDS.subscription, commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
		
		// get updated routing for feedback
		this.getChannelNames (ipaddress, 'rx');
    },



    getChannelCount(ipaddress) {
        const commandBuffer = this.makeCommand(DANTE_COMMANDS.channelCount);
        this.sendCommand(commandBuffer, ipaddress);

        return this.devicesData[ipaddress]?.channelCount;
    },



    getChannelNames(ipaddress, ...channelTypes) { 
		if (channelTypes==undefined){
				channelTypes=['rx','txInfo'];
		}
		let commandBuffer, commandArguments= Buffer.from("0001000100", "hex");
		  for (let channelType of channelTypes) { 
		  switch (channelType) {
			case 'tx' :
				for (let page = 0; page < this.devicesData[ipaddress]?.tx?.count/32; page++ ) {
					commandArguments.writeUInt8(page*32+1, 3);
					commandBuffer = this.makeCommand(DANTE_COMMANDS.txChannelNames, commandArguments);
					this.sendCommand(commandBuffer, ipaddress);
				}
				break;
		
			case 'rx' :
				for (let page = 0; page < this.devicesData[ipaddress]?.rx?.count/16; page++ ) { 
					commandArguments.writeUInt8(page*16+1, 3);
					commandBuffer = this.makeCommand(DANTE_COMMANDS.rxChannelNames, commandArguments);
					this.sendCommand(commandBuffer, ipaddress);
				}
				break;
		
			case 'txInfo' :
				for (let page = 0; page < this.devicesData[ipaddress]?.tx?.count/32; page++ ) {
					commandArguments.writeUInt8(page*32+1, 3);
					commandBuffer = this.makeCommand(DANTE_COMMANDS.txChannelInfo, commandArguments);
					this.sendCommand(commandBuffer, ipaddress);
				}
				break;
			}
		}
        return
    },
	



	getDeviceName(ipaddress) {
		const commandBuffer = this.makeCommand(DANTE_COMMANDS.deviceName);
		this.sendCommand(commandBuffer, ipaddress);
	},
	
	getSettings(ipaddress) {
		const commandBuffer = this.makeCommand(DANTE_COMMANDS.deviceSettings)
		this.sendCommand(commandBuffer, ipaddress);
	},
	
	
	setLatency(ipaddress, latency) {
		let commandArguments = Buffer.from("050382050020021100108301002400000000000000000000000000000000", "hex");
		commandArguments.writeUInt32BE(latency*1000000,22);
		commandArguments.writeUInt32BE(latency*1000000,26);
		const commandBuffer = this.makeCommand(DANTE_COMMANDS.setDeviceSettings, commandArguments)
		this.sendCommand(commandBuffer, ipaddress);
	},

	setSampleRate(ipaddress, sampleRate) {
		const arguments = Buffer.concat ([
			Buffer.from ('0000006400000001', 'hex'),
			intToBuffer(sampleRate, 4)
			]);
		const commandBuffer = this.makeSettingCommand(DANTE_COMMANDS.MESSAGE_TYPE_SAMPLE_RATE_CONTROL, arguments); 
		this.sendCommand(commandBuffer, ipaddress, DANTE_PORTS.SETTINGS);
		this.sendCommand(commandBuffer, ipaddress, DANTE_PORTS.DVS_SETTINGS);
	},	
	
	setEncoding(ipaddress, encoding) {
		const arguments = Buffer.concat([
			Buffer.from ('0000006400000001', 'hex'),
			intToBuffer(encoding, 4)
			]);
		const commandBuffer = this.makeSettingCommand(DANTE_COMMANDS.MESSAGE_TYPE_ENCODING_CONTROL, arguments); 
		this.sendCommand(commandBuffer, ipaddress, DANTE_PORTS.SETTINGS);
		this.sendCommand(commandBuffer, ipaddress, DANTE_PORTS.DVS_SETTINGS); 
	},	

	setGain(ipaddress, direction= 'out', channelNumber, gainSetting) {
		const arguments = Buffer.concat ([
			Buffer.from('00000000', 'hex'),
			Buffer.from('00010001', 'hex'),
			Buffer.from('000c0010', 'hex'),
			Buffer.from('02010000', 'hex'),
			intToBuffer(channelNumber, 4),
			intToBuffer(gainSetting, 4)
		]);
		
		const commandBuffer = this.makeSettingCommand(DANTE_COMMANDS.MESSAGE_TYPE_CODEC_CONTROL, arguments);
		this.sendCommand(commandBuffer, ipaddress, DANTE_PORTS.SETTINGS);
	},
	

    get devices() {
      return this.devicesData;
    },


	
	
	dante_discovery: function(response, rinfo) {
		response?.answers?.forEach((answer) => {
			if (answer.name?.match(/_netaudio-arc._udp/)) {
			  this.getDeviceName(rinfo.address);
			}
		});
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
		let commandBuffer;

		self.log('debug', 'getting info');
		
		self.mdns?.query({
			questions:[{
				name:'_netaudio-arc._udp.local',
				type:'PTR'
			}]
		});

		self.txFriendlyNameRefreshCounter = (self.txFriendlyNameRefreshCounter || 0) + 1;
		const refreshTxFriendlyNames = self.txFriendlyNameRefreshCounter % 15 == 0;
		
		for (ip in this.devicesData) {
			if (refreshTxFriendlyNames) {
				this.getChannelNames(ip, 'txInfo', 'tx', 'rx');
			} else {
				this.getChannelNames(ip, 'txInfo', 'rx');
			}
			this.getSettings(ip);
		}
		
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
