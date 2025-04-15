const multidns = require('multicast-dns');
const dgram = require("dgram");
const merge = require("./dante-control/utils/merge");
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



/*
function reverse(s) {
    return s.split("").reverse().join("");
};
*/
const getRandomInt = (max) => {
    return Math.floor(Math.random() * max);
};

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


const parseChannelCount = (reply) => {
    const channelInfo = { tx: {count: reply[13]}, rx :{count:reply[15]} };
    return channelInfo;
};

const parseTxChannelNames = (reply) => {
	const names = {};
	names.tx = {};
	const namesString = reply.toString('ascii');
	const channelCount = reply[10];
	const namesCount = reply[11];
	const startIndex = 12;
	
	for (let i = 0; i < namesCount; i++) {
		const readIndex = startIndex + (6 * i);
		const infoBuffer = reply.slice (readIndex, readIndex + 6);
		const nameIndex = bufferToInt(infoBuffer);
		const nameNumber = bufferToInt(infoBuffer,2);
		const nameAddress = bufferToInt(infoBuffer,4);
		const name = parseString(namesString, nameAddress);
		if (names.tx[nameNumber] == undefined) {
			names.tx[nameNumber]={};
		}
		names.tx[nameNumber].name = name;
	}
    return names;
};
	
	
const parseRxChannelNames = (reply) => {
	const names = {};
	names.rx = {};
	const namesString = reply.toString('ascii');
	const channelCount = reply[10];
	const namesCount = reply[11];
	const startIndex = 12;
	
	for (let i = 0; i < namesCount; i++) {
		const readIndex = startIndex + (20 * i);
		const infoBuffer = reply.slice(readIndex, readIndex + 20);
		const nameNumber = bufferToInt(infoBuffer);
		const nameAddress = bufferToInt(infoBuffer, 10);
		const name = parseString(namesString, nameAddress);
		if (names.rx[nameNumber] == undefined) {
			names.rx[nameNumber]={};
		}
		names.rx[nameNumber].name = name;
	}
    return names;
};
	
const parseChannelNames = (reply, ioString) => {
	const names = {};
	names[ioString] = {};
	const namesString = reply.toString('ascii');
	const channelCount = reply[10];
	const namesCount = reply[11];
	const startIndex = 12;
	let  infoBufferSize, nameNumberOffset, nameAddressOffset;
	
	if (ioString == 'tx') {
		infoBufferSize = 6;
		nameNumberOffset = 2;
		nameAddressOffset = 4;
	} else if (ioString == 'rx') {
		infoBufferSize = 20;
		nameNumberOffset = 0;
		nameAddressOffset = 10;
	}
	for (let i = 0; i < namesCount; i++) {
		const readIndex = startIndex + (infoBufferSize * i);
		const infoBuffer = reply.slice(readIndex, readIndex + infoBufferSize);
		const nameNumber = bufferToInt(infoBuffer, nameNumberOffset);
		const nameAddress = bufferToInt(infoBuffer, nameAddressOffset);
		const name = parseString(namesString, nameAddress);
		if (names[ioString][nameNumber] == undefined) {
			names[ioString][nameNumber]={};
		}
		names[ioString][nameNumber].name = name;
	}
    return names;
}

const parseDeviceName = (reply) => {
	return {name: parseString(reply.toString('ascii'), 10)};
}
	



module.exports = {
	
		
	initConnection: function () {
		let self = this;
		
		this.socket = dgram.createSocket({type: "udp4" , reusePort: true});

        this.socket.on("message", this.parseReply.bind(this));
        this.socket.on("error", (error)=>{
			self.updateStatus(InstanceStatus.Disconnected);
			self.log('error', error.message);
		});

        this.socket.on("listening", ()=>{self.updateStatus(InstanceStatus.Ok);}); 
        
        this.socket.bind(danteControlPort, self.config.ip);

		this.debug = this.config.verbose;
		
		self.log('debug', 'getting information function');
		self.devicesIp = {};
		self.devicesData = {};
		
		self.devicesChoices = [];
		self.txChannelsChoices = {};
		self.rxChannelsChoices = {};

		self.getInformation();

		self.setupInterval();
		self.mdns = multidns({interface: self.config.ip});
		self.mdns.on('response', self.dante_discovery.bind(this));
		
		self.mdns?.query({
			questions:[{
				name:'_netaudio-arc._udp.local',
				type:'PTR'
			}]
		});
	},
	
	
	insertDeviceChoice: function (deviceIp, deviceName) {
		this.log('info', 'INSERT DEVICE : ' + deviceName);
		this.devicesChoices.push({id: deviceIp, label: deviceName});
		this.devicesChoices.sort((deviceA, deviceB) => {
				return deviceA.label.localeCompare(deviceB.label);
		});
		this.initActions();
	},
	
	updateDeviceChoice: function (deviceIp, deviceName) {
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
	  
		this.log('info', 'UPDATE DEVICE : ' + deviceName);
	},
	
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
				channelChoice.push({id: channelName ?? indexString, label: indexString + (channelName ? ' : ' + channelName : '')});
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
		
//		console.log('NAMES CHOICES FOR ', deviceName,'-', ioString, ' : \n',this[ioString+'ChannelsChoices'][deviceName]);
	},


    parseReply: function(reply, rinfo) {
        const deviceIp= rinfo.address;
        const replySize = rinfo.size;
        const deviceData = {};
	    	let updateFlags = [];

        if (this.debug) {
            // Log replies when in debug mode
            this.log('debug', `Rx (${reply.length}): ${reply.toString("hex")}`);
        }

        if (reply[0] === danteConstant[0] && reply[1] === sequenceId1[0]) {
            if (replySize === bufferToInt(reply.slice(2, 4))) {
                const commandId = reply.slice(6, 8);
                deviceData[deviceIp] = {};
                switch (bufferToInt(commandId)) {
					
				    case 4096:
					// channelCount :
                        deviceData[deviceIp] = parseChannelCount(reply);
						if (deviceData[deviceIp].rx.count != this.devicesData[deviceIp]?.rx?.count) {
							this.getChannelNames(deviceIp, 'rx');
						}
						if (deviceData[deviceIp].tx.count != this.devicesData[deviceIp]?.tx?.count) {
							this.getChannelNames(deviceIp, 'tx');
						}

                        break;
						
                    case 8208:
					// txChannelNames :
                        deviceData[deviceIp] = parseChannelNames(reply,'tx');
						//deviceData[deviceIp] = parseTxChannelNames(reply);
						updateFlags.push('tx');
                        break;
						
					case 12288 : 
					// rxChannelNames
						deviceData[deviceIp] = parseChannelNames(reply,'rx');
						//deviceData[deviceIp] = parseRxChannelNames(reply);
						updateFlags.push('rx');
						break;
						
					case 4098 : 
					// deviceName
						deviceData[deviceIp] = parseDeviceName(reply);
						
						// update Devices choices for actions if necessary
						if (!this.devicesData[deviceIp]?.name) {
							this.insertDeviceChoice(deviceIp, deviceData[deviceIp].name);
						// retrieve channel count if new device
							this.getChannelCount(deviceIp);
						} else if (this.devicesData[deviceIp].name != deviceData[deviceIp].name) {
							this.updateDeviceChoice(deviceIp, deviceData[deviceIp].name);
						}
						break;
                }
				
				
				if (this.debug) {
                    // Log parsed device information when in debug mode
				    console.log('DEVICE DATA : ', this.devicesData);
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

        const commandArguments = Buffer.concat([
		/*
            Buffer.from("0401", "hex"),
            intToBuffer(destinationChannelNumber),
            Buffer.from("005c006d", "hex"),
            Buffer.alloc(107 - sourceChannelNameBuffer.length - sourceDeviceNameBuffer.length),
            sourceChannelNameBuffer,
            Buffer.alloc(1),
            sourceDeviceNameBuffer,
			*/
			Buffer.from('0001', 'hex'),
			intToBuffer (destinationChannelNumber),
			intToBuffer (22),
			intToBuffer(22 + sourceChannelNameBuffer.length+1),
			Buffer.alloc(4),
			sourceChannelNameBuffer,
			Buffer.alloc(1),
			sourceDeviceNameBuffer,
        ]);

        const commandBuffer = this.makeCommand("subscription", commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
    },

    clearCrosspoint(ipaddress, destinationChannelNumber) {
        const commandArguments = Buffer.concat([
            Buffer.from("0401", "hex"),
            intToBuffer(destinationChannelNumber),
            Buffer.from("005c006d", "hex"),
            Buffer.alloc(108),
        ]);

        const commandBuffer = this.makeCommand("subscription", commandArguments);

        this.sendCommand(commandBuffer, ipaddress);
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
	
/*
				if (name && (!this.devicesList.includes(name))) {
					this.devicesList.push(name);
					this.log('info', 'Adding device : ' + name);
*/					
					response.additionals.forEach((additional) => {
						if (additional.type == 'A') {
//							this.devicesIp[name] = additional.data;
//							let deviceData = {}
//							deviceData[additional.data] = {name: name};
//							merge (this.devicesData, deviceData); 
							this.getDeviceName(additional.data);
						}
					});
					
					/*
					// get channels info from devices
					let ip = this.devicesIp[name] ?? name+'.local'
					this.getChannelCount(ip);					
					this.getChannelNames(ip);
					*/
					// updates actions choices
/*					let deviceChoice = { 'id' : name, 'label' : name};
					this.devicesChoices.push(deviceChoice);
					this.devicesChoices.sort((deviceA, deviceB) => {
						return deviceA.label.localeCompare(deviceB.label);
						
					});*/
			}
		});
		this.initActions();
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
		/*
		for (ip in this.devicesData) {
			commandBuffer = this.makeCommand("deviceInfo");
			this.sendCommand(commandBuffer, ip);
		}
		*/
		self.checkVariables();
	},
	
	updateData: function (bytes) {
		let self = this;
	
		//do more stuff
	
		self.checkFeedbacks();
		self.checkVariables();
	},
}
