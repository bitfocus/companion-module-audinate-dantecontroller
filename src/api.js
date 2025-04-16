const multidns = require('multicast-dns');
const dgram = require("dgram");
const merge = require("./utils/merge");
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
	setRxChannelName : Buffer.from([0x30, 0x01]),
	setTxChannelName : Buffer.from([0x20, 0x13]),
	setDeviceName : Buffer.from([0x10, 0x01])
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


const parseString = (string, startIndex) => {
  let text ='';
  for (let i=startIndex; i< string.length; i++) {
    if (string[i] === '\x00') {
      break;
    } else {
      text += string[i];
    }
  }
  return text;
};




//** 
//** Dante messages parsing
//**

const parseChannelCount = (reply) => {
    const channelInfo = { tx: {count: reply[13]}, rx :{count:reply[15]} };
    return channelInfo;
};



const parseChannelNames = (reply, ioString) => {
	const channelInfo = {};
	channelInfo[ioString] = {};
	
	const namesString = reply.toString('ascii');
	const channelCount = reply[10];
	const namesCount = reply[11];
	const startIndex = 12;
	const sourceChannelOffset = 6;
	const sourceDeviceOffset = 8;
	let  infoBufferSize, nameNumberOffset, nameIndexsOffset;

// set indices for rx or tx
	if (ioString == 'tx') {
		infoBufferSize = 6;
		nameNumberOffset = 2;
		nameIndexOffset = 4;
	} else if (ioString == 'rx') {
		infoBufferSize = 20;
		nameNumberOffset = 0;
		nameIndexOffset = 10;
	}
	
	// for each channel
	for (let i = 0; i < namesCount; i++) {
		// get info chunk of channel
		const infoIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(infoIndex, infoIndex + infoBufferSize);
		// get channel number and byte index of name
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset);
		const nameIndex = bufferToInt(infoBuffer, nameIndexOffset);
		// get name
		const name = parseString(namesString, nameIndex);
		
		// create return object if needed
		if (channelInfo[ioString][nameNumber] == undefined) {
			channelInfo[ioString][nameNumber]={};
		}
		channelInfo[ioString][nameNumber].name = name;
		
		// get routing
		if (ioString == 'rx') {
			const sourceChannelIndex = bufferToInt(infoBuffer, sourceChannelOffset);
			const sourceDeviceIndex = bufferToInt(infoBuffer, sourceDeviceOffset);
			const sourceChannel = parseString(namesString, sourceChannelIndex);
			const sourceDevice = parseString(namesString, sourceDeviceIndex);
		
			channelInfo[ioString][nameNumber].sourceDevice = sourceDevice;
			channelInfo[ioString][nameNumber].sourceChannel = sourceChannel;
		}
	}
    return channelInfo;
}



const parseDeviceName = (reply) => {
	return {name: parseString(reply.toString('ascii'), 10)};
}



//**
//** Module API
//**




module.exports = {
	
		
	initConnection: function () {
		let self = this;
		
		
		// create Dante communication udp socket
		this.socket = dgram.createSocket({type: "udp4"}); // , reusePort: true});

        this.socket.on("message", this.parseReply.bind(this));
        this.socket.on("error", (error)=>{
			self.log('error', error.message);
		});

        this.socket.on("listening", ()=>{self.updateStatus(InstanceStatus.Ok);}); 
        
		// bind socket to random port of configured ip address
        this.socket.bind(0, self.config.ip);

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
		self.getInformation();
		
	},
	
	
	// add device choice item for actions and feedbacks
	insertDeviceChoice: function (deviceIp, deviceName) {
		this.log('info', 'INSERT DEVICE : ' + deviceName);
		
		this.devicesChoices.push({id: deviceIp, label: deviceName});
		this.devicesChoices.sort((deviceA, deviceB) => {
				return deviceA.label.localeCompare(deviceB.label);
		});
		
		this.initActions();
		this.initVariables();
		this.checkVariables();
		this.initFeedbacks();
		this.checkFeedbacks();
	},
	
	// update device name in dropdown choice
	updateDeviceChoice: function (deviceIp, deviceName) {
		
		this.log('info', 'UPDATE DEVICE NAME : ' + deviceName);
		
		for (let device of this.devicesChoices) {
			if (device.id == deviceIp) {
			device.label=deviceName;
			this.devicesChoices.sort((deviceA, deviceB) => {
				return deviceA.label.localeCompare(deviceB.label);
			});
			break;
			}
		}
		
		this.initActions();
		this.initVariables();
		this.checkVariables();
		this.initFeedbacks();
		this.checkFeedbacks();
	},
	
	
	
	// create or update channels name in dropdown choices for either rx or tx (ioString)
	updateChannelChoices: function(deviceIp, ioString) {

		if (!(this.devicesData[deviceIp] && this.devicesData[deviceIp][ioString])) {
			this.log('error', "ERROR : Can't update channelsChoices for device " + deviceIp);
			return;
		}
  
		let deviceName = this.devicesData[deviceIp].name;
		let ioObject = this.devicesData[deviceIp][ioString];
  
		let channelChoice = [{id: 0, label:'None'}];
		if (ioString == 'tx') {
			for (let i = 1; i<= ioObject.count; i++) {
				let indexString = i.toString().padStart(2,'0');
				let channelName = ioObject[i]?.name;
				channelChoice[i] = {id: channelName ?? indexString, label: indexString + (channelName ? ' : ' + channelName : '')};
			}
		} else if (ioString == 'rx') {
			for (let i = 1; i<= ioObject.count; i++) {
				let indexString = i.toString().padStart(2,'0');
				let channelName = ioObject[i]?.name ?? '';
				channelChoice.push({id: i, label: indexString + (channelName ? ' : ' + channelName : '')});
			}
		}
		
		this[ioString+'ChannelsChoices'][deviceName] = channelChoice;
		
		this.initActions();
		this.initVariables();
		this.checkVariables();
		this.initFeedbacks();
		this.checkFeedbacks();
	},



// destroy device registration
	destroyDevice : function (deviceIp) {
		const deviceName = this.devicesData[deviceIp]?.name;
		this.log('warn', `${deviceName} is offline. Destroying references`);
		
		// delete channels name choices
		for (const ioString of ['rx', 'tx']) {
			delete this[ioString+'ChannelsChoices'][deviceName];
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

		this.initActions();
		this.initVariables();
		this.checkVariables();
		this.initFeedbacks();
		this.checkFeedbacks();
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
        const deviceIp= rinfo.address;
        const replySize = rinfo.size;
        let deviceData = {};
    	let updateFlags = [];

        if (this.debug) {
            // Log replies when in debug mode
            this.log('debug', `Rx (${reply.length}): ${reply.toString("hex")}`);
        }

        if (reply[0] === danteConstant[0] && reply[1] === sequenceId1[0]) {
            if (replySize === bufferToInt(reply.slice(2, 4))) {
                const commandId = reply.slice(6, 8);
				
				// device is online
				this.keepAlive(deviceIp);
                
				deviceData[deviceIp] = {};
				
                switch (bufferToInt(commandId)) {
					
					// channelCount	
				    case 4096:
                        deviceData[deviceIp] = parseChannelCount(reply);
						
						// if channel count has changed, retrieve channel names
						if (deviceData[deviceIp].rx.count != this.devicesData[deviceIp]?.rx?.count) {
							this.getChannelNames(deviceIp, 'rx');
						}
						if (deviceData[deviceIp].tx.count != this.devicesData[deviceIp]?.tx?.count) {
							this.getChannelNames(deviceIp, 'tx');
						}
                        break;
						
					// txChannelNames
                    case 8208:
                        deviceData[deviceIp] = parseChannelNames(reply,'tx');
						updateFlags.push('tx');
                        break;
						
					// rxChannelNames
					case 12288 : 
						deviceData[deviceIp] = parseChannelNames(reply,'rx');
						updateFlags.push('rx');
						break;
						
					// deviceName
					case 4098 : 
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

						// retrieve channel count if new device
							this.getChannelCount(deviceIp);
						} else if (this.devicesData[deviceIp].name != deviceData[deviceIp].name) {
							this.updateDeviceChoice(deviceIp, deviceData[deviceIp].name);
						}
						break;
                }
				
				
				if (this.debug) {
                    // Log parsed device information when in debug mode
				    console.log('DEVICE DATA : ', deviceData);
                }
				this.devicesData = merge(this.devicesData, deviceData);
				
				// update Channels choices for actions if necessary
				for (const flag of updateFlags) {
					this.updateChannelChoices(deviceIp, flag);
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


    getChannelNames(ipaddress, io = '') {
		let commandBuffer;
		if (io != 'rx') {
			commandBuffer = this.makeCommand("txChannelNames", Buffer.from("0001000100", "hex"));
			this.sendCommand(commandBuffer, ipaddress);
		}
		if (io != 'tx') {
			commandBuffer = this.makeCommand("rxChannelNames", Buffer.from("0001000100", "hex"));
			this.sendCommand(commandBuffer, ipaddress);
		}

        return this.devicesData[ipaddress]?.channelNames;
    },
	
	
	
	getDeviceName(ipaddress) {
		const commandBuffer = this.makeCommand("deviceName");
		this.sendCommand(commandBuffer, ipaddress);
	},


    get devices() {
      return this.devicesData;
    },


	
	
	dante_discovery: function(response) {
		response?.answers?.forEach((answer) => {
			if (answer.name?.match(/_netaudio-arc._udp/)) {
				let name = answer.data?.toString().slice(0, -25);
	
				response.additionals.forEach((additional) => {
					if (additional.type == 'A') {
						this.getDeviceName(additional.data);
					}
				});
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
			this.getChannelNames(ip);
		}
		
		self.checkVariables();
	},
	
	updateData: function (bytes) {
		let self = this;
	
		//do more stuff
	
		self.checkFeedbacks();
		self.checkVariables();
	},
}
