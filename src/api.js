const multidns = require('multicast-dns');
const dgram = require("dgram");
const merge = require("./utils/merge");
const { networkInterfaces } = require('os');
const { InstanceStatus, Regex } = require('@companion-module/base')

const danteServiceTypes = ["_netaudio-cmc._udp", "_netaudio-dbc._udp", "_netaudio-arc._udp", "_netaudio-chan._udp"];
const danteControlPort = 4440;
const sequenceId1 = Buffer.from([0x29]);
const danteConstant = Buffer.from([0x27]);


const DANTE_COMMANDS = {
	channelCount : Buffer.from("1000", "hex"),
	deviceInfo : Buffer.from("1003", "hex"),
	deviceName : Buffer.from("1002", "hex"),
	subscription : Buffer.from("3010", "hex"),
	rxChannelNames : Buffer.from("3000", "hex"),
	txChannelNames : Buffer.from("2010", "hex"),
	txChannelInfo : Buffer.from("2000", "hex"),
	setRxChannelName : Buffer.from([0x30, 0x01]),
	setTxChannelName : Buffer.from([0x20, 0x13]),
	setDeviceName : Buffer.from([0x10, 0x01]),
	deviceSettings : Buffer.from("1100", "hex"),
	setDeviceSettings : Buffer.from("1101", "hex"),
	
REQUEST_DANTE_MODEL : Buffer.from([97]),
REQUEST_MAKE_MODEL : Buffer.from([193]),
RESPONSE_DANTE_MODEL : Buffer.from([96]),
RESPONSE_MAKE_MODEL : Buffer.from([192]),


MESSAGE_TYPE_CHANNEL_COUNTS_QUERY : 4096,
MESSAGE_TYPE_DEVICE_CONTROL : 4099,
MESSAGE_TYPE_IDENTIFY_DEVICE_QUERY : 4302,
MESSAGE_TYPE_NAME_CONTROL : 4097,
MESSAGE_TYPE_NAME_QUERY : 4098,
MESSAGE_TYPE_RX_CHANNEL_QUERY : 12288,
MESSAGE_TYPE_TX_CHANNEL_QUERY : 8192,
MESSAGE_TYPE_TX_CHANNEL_FRIENDLY_NAMES_QUERY : 8208,

MESSAGE_TYPE_ACCESS_CONTROL : 177,
MESSAGE_TYPE_ACCESS_STATUS : 176,
MESSAGE_TYPE_AES67_CONTROL : 4102,
MESSAGE_TYPE_AES67_STATUS : 4103,
MESSAGE_TYPE_AUDIO_INTERFACE_QUERY : 135,
MESSAGE_TYPE_AUDIO_INTERFACE_STATUS : 134,
MESSAGE_TYPE_CLEAR_CONFIG_CONTROL : 119,
MESSAGE_TYPE_CLEAR_CONFIG_STATUS : 120,
MESSAGE_TYPE_CLOCKING_CONTROL : 33,
MESSAGE_TYPE_CLOCKING_STATUS : 32,
MESSAGE_TYPE_CODEC_CONTROL : 4106,
MESSAGE_TYPE_CODEC_STATUS : 4107,
MESSAGE_TYPE_CONFIG_CONTROL : 115,
MESSAGE_TYPE_DDM_ENROLMENT_CONFIG_CONTROL : 65286,
MESSAGE_TYPE_DDM_ENROLMENT_CONFIG_STATUS : 65287,
MESSAGE_TYPE_DEVICE_REBOOT : 146,
MESSAGE_TYPE_EDK_BOARD_CONTROL : 161,
MESSAGE_TYPE_EDK_BOARD_STATUS : 160,
MESSAGE_TYPE_ENCODING_CONTROL : 131,
MESSAGE_TYPE_ENCODING_STATUS : 130,
MESSAGE_TYPE_HAREMOTE_CONTROL : 4097,
MESSAGE_TYPE_HAREMOTE_STATUS : 4096,
MESSAGE_TYPE_IDENTIFY_QUERY : 99,
MESSAGE_TYPE_IDENTIFY_STATUS : 98,
MESSAGE_TYPE_IFSTATS_QUERY : 65,
MESSAGE_TYPE_IFSTATS_STATUS : 64,
MESSAGE_TYPE_IGMP_VERS_CONTROL : 81,
MESSAGE_TYPE_IGMP_VERS_STATUS : 80,
MESSAGE_TYPE_INTERFACE_CONTROL : 19,
MESSAGE_TYPE_INTERFACE_STATUS : 17,
MESSAGE_TYPE_LED_QUERY : 209,
MESSAGE_TYPE_LED_STATUS : 208,
MESSAGE_TYPE_LOCK_QUERY : 4104,
MESSAGE_TYPE_LOCK_STATUS : 4105,
MESSAGE_TYPE_MANF_VERSIONS_QUERY : 193,
MESSAGE_TYPE_MANF_VERSIONS_STATUS : 192,
MESSAGE_TYPE_MASTER_QUERY : 35,
MESSAGE_TYPE_MASTER_STATUS : 34,
MESSAGE_TYPE_METERING_CONTROL : 225,
MESSAGE_TYPE_METERING_STATUS : 224,
MESSAGE_TYPE_NAME_ID_CONTROL : 39,
MESSAGE_TYPE_NAME_ID_STATUS : 38,
MESSAGE_TYPE_PROPERTY_CHANGE : 262,
MESSAGE_TYPE_ROUTING_DEVICE_CHANGE : 288,
MESSAGE_TYPE_ROUTING_READY : 256,
MESSAGE_TYPE_RX_CHANNEL_CHANGE : 258,
MESSAGE_TYPE_RX_CHANNEL_RX_ERROR_QUERY : 273,
MESSAGE_TYPE_RX_CHANNEL_RX_ERROR_STATUS : 272,
MESSAGE_TYPE_RX_ERROR_THRESHOLD_CONTROL : 275,
MESSAGE_TYPE_RX_ERROR_THRESHOLD_STATUS : 274,
MESSAGE_TYPE_RX_FLOW_CHANGE : 261,
MESSAGE_TYPE_SAMPLE_RATE_CONTROL : 129,
MESSAGE_TYPE_SAMPLE_RATE_PULLUP_CONTROL : 133,
MESSAGE_TYPE_SAMPLE_RATE_PULLUP_STATUS : 132,
MESSAGE_TYPE_SAMPLE_RATE_STATUS : 128,
MESSAGE_TYPE_SERIAL_PORT_CONTROL : 241,
MESSAGE_TYPE_SERIAL_PORT_STATUS : 240,
MESSAGE_TYPE_SWITCH_VLAN_CONTROL : 21,
MESSAGE_TYPE_SWITCH_VLAN_STATUS : 20,
MESSAGE_TYPE_SYS_RESET : 144,
MESSAGE_TYPE_TOPOLOGY_CHANGE : 16,
MESSAGE_TYPE_TX_CHANNEL_CHANGE : 257,
MESSAGE_TYPE_TX_FLOW_CHANGE : 260,
MESSAGE_TYPE_TX_LABEL_CHANGE : 259,
MESSAGE_TYPE_UNICAST_CLOCKING_CONTROL : 37,
MESSAGE_TYPE_UNICAST_CLOCKING_STATUS : 36,
MESSAGE_TYPE_UPGRADE_CONTROL : 113,
MESSAGE_TYPE_UPGRADE_STATUS : 112,
MESSAGE_TYPE_VERSIONS_QUERY : 97,
MESSAGE_TYPE_VERSIONS_STATUS : 96,

};


const getRandomInt = (max) => {
    return Math.floor(Math.random() * max);
};



//**
//** utils functions to parse dante messages
//**

const intToBuffer = (int) => {
    let intBuffer = Buffer.alloc(2);
    intBuffer.writeUInt16BE(int);
    return intBuffer;
};

const bufferToInt = (buffer, offset = 0) => {
    return buffer.readUInt16BE(offset);
};


const parseString = (buffer, startIndex) => {
  const end = buffer.indexOf(0x00, startIndex);
  return buffer.toString('utf8', startIndex, end);
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
		
		// get name
		returnChannel.name = parseString(reply, nameIndex);
		
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



const parseDeviceName = (reply) => {
	return {name: parseString(reply, 10)};
}

const parseDeviceSettings = (reply) => {
	const deviceInfo = {};
	const recCount = reply[11];
	const startIndex = 12;
	const infoBufferSize = 4;
	
	for (let i = 0; i < recCount ; i++) {
		// get info chunk of channel
		const infoIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(infoIndex, infoIndex + infoBufferSize);
		
		const infoCode = infoBuffer.readUInt16BE(0);
		const valueIndex = infoBuffer.readUInt16BE(2);
		
		switch (infoCode) {
			case 0x8020:
			// Sample rate
				deviceInfo.sr = reply.readUInt32BE(valueIndex);
				break;
				
			case 0x8204: 
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
	
		
	initConnection: function () {
		let self = this;
		
		// get available Ips
		const nets = networkInterfaces();
		let availableIps = [];
		for (const name of Object.keys(nets)) {
			for (const net of nets[name]) { 
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        // 'IPv4' is in Node <= 17, from 18 it's a number 4 or 6
				const familyV4Value = (typeof net.family === 'string') ? 'IPv4' : 4
				if (net.family === familyV4Value && !net.internal) {
					availableIps.push(net.address);
				}
			}
		}
		
		
		// create Dante communication udp socket
		this.socket = dgram.createSocket({type: "udp4"}); // , reusePort: true});

 	       	this.socket.on("message", this.parseReply.bind(this));
    		this.socket.on("error", (error)=>{
			self.log('error', error.message);
		});

        this.socket.on("listening", ()=>{self.updateStatus(InstanceStatus.Connecting);}); 
        
		// bind socket to random port of configured ip address if available
		if (availableIps.includes(self.config.ip)) {
			this.socket.bind(0, self.config.ip);
		} else {
			this.socket.bind();
		}

		this.debug = this.config.verbose;
		this.timeout = this.config.timeoutInterval;
		
		// create data object
		self.devicesData = {};
		
		// create actions and feedback dropdown choices
		self.devicesChoices = [];
		self.txChannelsChoices = {};
		self.rxChannelsChoices = {};



		self.setupInterval();
		self.mdns = multidns({interface: self.config.ip});
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
				let indexString = i.toString().padStart(2,'0');
				let channelName = ioObject[i]?.name;
				channelChoice[i] = {id: channelName, label : channelName}; //?? indexString, label: indexString + (channelName ? ' : ' + channelName : '')};
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

        if (reply[0] === danteConstant[0] && reply[1] === sequenceId1[0]) {
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
							this.getChannelNames(deviceIp, 'txInfo');
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



    sendCommand(command, host, port = danteControlPort) {
        if (this.debug) {
            // Log sent bytes when in debug mode
            this.log('debug', `Tx (${command.length}): ${command.toString("hex")}`);
        }

        this.socket.send(command, 0, command.length, port, host);
    },

	
	
// create Dante message
    makeCommand(command, commandArguments = Buffer.alloc(2)) {
        let sequenceId2 = Buffer.alloc(2);
        sequenceId2.writeUInt16BE(getRandomInt(65535));

        const padding = Buffer.from([0x00, 0x00]);
        let commandLength = Buffer.alloc(2);
        let commandId = Buffer.alloc(2);

		commandId = Buffer.from(DANTE_COMMANDS[command]);
		
        commandLength.writeUInt16BE(
            Buffer.concat([
                danteConstant,
                sequenceId1,
                sequenceId2,
                commandId,
                Buffer.alloc(2),
                commandArguments,
                Buffer.alloc(1),
            ]).length + 2
        );

        return Buffer.concat([
            danteConstant,
            sequenceId1,
            commandLength,
            sequenceId2,
            commandId,
            Buffer.alloc(2),
            commandArguments,
            Buffer.alloc(1),
        ]);
    },


//**
//** Specific Dante messages
//**

    resetDeviceName(ipaddress) {
        const commandBuffer = this.makeCommand("setDeviceName");
        this.sendCommand(commandBuffer, ipaddress);
    },

    setDeviceName(ipaddress, name) {
        const commandBuffer = this.makeCommand("setDeviceName", Buffer.from(name, "ascii"));
        this.sendCommand(commandBuffer, ipaddress);
    },

    setChannelName(ipaddress, channelName = "", channelType = "rx", channelNumber = 0) {
        const channelNameBuffer = Buffer.from(channelName, "ascii");
        let commandBuffer = Buffer.alloc(1);
        let channelNumberBuffer = Buffer.alloc(2);
        channelNumberBuffer.writeUInt16BE(channelNumber);

        if (channelType === "rx") {
            const commandArguments = Buffer.concat([
                Buffer.from("0401", "hex"),
                channelNumberBuffer,
                Buffer.from("001c", "hex"),
                Buffer.alloc(12),
                channelNameBuffer,
            ]);
            commandBuffer = this.makeCommand("setRxChannelName", commandArguments);
        } else if (channelType === "tx") {
            const commandArguments = Buffer.concat([
                Buffer.from("040100000", "hex"),
                channelNumberBuffer,
                Buffer.from("0024", "hex"),
                Buffer.alloc(18),
                channelNameBuffer,
            ]);
            commandBuffer = this.makeCommand("setTxChannelName", commandArguments);
        } else {
            throw "Invalid Channel Type - must be 'tx' or 'rx'";
        }
        this.sendCommand(commandBuffer, ipaddress);
    },



    resetChannelName(ipaddress, channelType = "rx", channelNumber = 0) {
        this.setChannelName(ipaddress, "", channelType, channelNumber);
    },



    makeCrosspoint(ipaddress, sourceChannelName, sourceDeviceName, destinationChannelNumber = 0) {
        const sourceChannelNameBuffer = Buffer.from(sourceChannelName, "ascii");
        const sourceDeviceNameBuffer = Buffer.from(sourceDeviceName, "ascii");

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

        const commandBuffer = this.makeCommand("subscription", commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
		
		// get updated routing for feedback
		this.getChannelNames(ipaddress, 'rx');
    },
	
	

    clearCrosspoint(ipaddress, destinationChannelNumber) {
        let commandArguments = Buffer.concat([
            Buffer.from("0401", "hex"),
            intToBuffer(destinationChannelNumber),
            Buffer.from("005c006d", "hex"),
            Buffer.alloc(1),
        ]);

        const commandBuffer = this.makeCommand("subscription", commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
		
		// get updated routing for feedback
		this.getChannelNames (ipaddress, 'rx');
    },



    getChannelCount(ipaddress) {
        const commandBuffer = this.makeCommand("channelCount");
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
					commandBuffer = this.makeCommand("txChannelNames", commandArguments);
					this.sendCommand(commandBuffer, ipaddress);
				}
				break;
		
			case 'rx' :
				for (let page = 0; page < this.devicesData[ipaddress]?.rx?.count/16; page++ ) { 
					commandArguments.writeUInt8(page*16+1, 3);
					commandBuffer = this.makeCommand("rxChannelNames", commandArguments);
					this.sendCommand(commandBuffer, ipaddress);
				}
				break;
		
			case 'txInfo' :
				for (let page = 0; page < this.devicesData[ipaddress]?.tx?.count/32; page++ ) {
					commandArguments.writeUInt8(page*32+1, 3);
					commandBuffer = this.makeCommand("txChannelInfo", commandArguments);
					this.sendCommand(commandBuffer, ipaddress);
				}
				break;
			}
		}
        return
    },
	



	getDeviceName(ipaddress) {
		const commandBuffer = this.makeCommand("deviceName");
		this.sendCommand(commandBuffer, ipaddress);
	},
	
	getSettings(ipaddress) {
		const commandBuffer = this.makeCommand('deviceSettings')
		this.sendCommand(commandBuffer, ipaddress);
	},
	
	
	setLatency(ipaddress, latency) {
		let commandArguments = Buffer.from("0000050382050020021100108301002482198301830283060000000000000000", "hex");
		commandArguments.writeUInt32BE(latency*100000,32);
		commandArguments.writeUInt32BE(latency*100000,36);
		const commandBuffer = this.makeCommand('setLatency', commandArguments)
		this.sendCommand(commandBuffer, ipaddress);
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
		
		for (ip in this.devicesData) {
			this.getChannelNames(ip, 'txInfo', 'rx');
			this.getSettings();
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
