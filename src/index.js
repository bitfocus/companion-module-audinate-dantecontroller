var instance_skel = require('../../../instance_skel')

var actions = require('./actions.js')
var presets = require('./presets.js')
var feedbacks = require('./feedbacks.js')
var variables = require('./variables.js')

const Dante = require('dante-control');

var debug;

instance.prototype.DANTE = null;

instance.prototype.INTERVAL = null; //used to poll the clock every second
instance.prototype.CONNECTED = false; //used for friendly notifying of the user that we have not received data yet

instance.prototype.DEVICEINFO = {
	channelCount: '',
	channelNames: ''
};

// ########################
// #### Instance setup ####
// ########################
function instance(system, id, config) {
	let self = this

	// super-constructor
	instance_skel.apply(this, arguments)

	return self
};

instance.GetUpgradeScripts = function () {
	
};

// Initalize module
instance.prototype.init = function () {
	let self = this;

	debug = self.debug;
	log = self.log;

	self.status(self.STATUS_WARNING, 'connecting');

	self.init_connection();

	self.init_actions();
	self.init_feedbacks();
	self.init_variables();
	self.init_presets();

	self.checkVariables();
	self.checkFeedbacks();
};

// Return config fields for web config
instance.prototype.config_fields = function () {
	let self = this

	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module controls Dante devices',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'IP Address',
			width: 4,
			regex: self.REGEX_IP
		},
		{
			type: 'text',
			id: 'intervalInfo',
			width: 12,
			label: 'Update Interval',
			value: 'Please enter the amount of time in milliseconds to request new information from the device. Set to 0 to disable.',
		},
		{
			type: 'textinput',
			id: 'interval',
			label: 'Update Interval',
			width: 3,
			default: 1000
		}
	]
};

// Update module after a config change
instance.prototype.updateConfig = function (config) {
	let self = this;
	self.config = config;

	self.status(self.STATUS_WARNING, 'connecting');
	
	self.init_connection();

	self.init_actions();
	self.init_feedbacks();
	self.init_variables();
	self.init_presets();

	self.checkVariables();	
	self.checkFeedbacks();
};

// When module gets deleted
instance.prototype.destroy = function () {
	let self = this;

	if (self.INTERVAL) {
		clearInterval(self.INTERVAL);
		self.INTERVAL = null;
	}

	debug('destroy', self.id)
};

instance.prototype.init_connection = function () {
	let self = this;

	if (self.config.host !== undefined) {
		//create dante object
		self.DANTE = new Dante();
		self.getInformation();
	}
};

instance.prototype.setupInterval = function() {
	let self = this;

	self.stopInterval();

	if (self.config.interval > 0) {
		self.INTERVAL = setInterval(self.getInformation.bind(self), self.config.interval);
		self.log('info', 'Starting Update Interval: Every ' + self.config.interval + 'ms');
	}
};

instance.prototype.stopInterval = function() {
	let self = this;

	if (self.INTERVAL !== null) {
		self.log('info', 'Stopping Update Interval.');
		clearInterval(self.INTERVAL);
		self.INTERVAL = null;
	}
};

instance.prototype.getInformation = async function () {
	//Get all information from Device
	let self = this;

	if (self.DANTE) {
		self.DEVICEINFO.channelCount = await self.DANTE.getChannelCount(self.config.host);
		self.DEVICEINFO.channelNames = await self.DANTE.getChannelNames(self.config.host);

		console.log('****info***')
		console.log(self.DEVICEINFO);
	}
};

instance.prototype.updateData = function (bytes) {
	let self = this;

	//do more stuff

	self.checkFeedbacks();
	self.checkVariables();
};

// ##########################
// #### Instance Actions ####
// ##########################
instance.prototype.init_actions = function (system) {
	this.setActions(actions.setActions.bind(this)());
};

// ############################
// #### Instance Feedbacks ####
// ############################
instance.prototype.init_feedbacks = function (system) {
	this.setFeedbackDefinitions(feedbacks.setFeedbacks.bind(this)());
};

// ############################
// #### Instance Variables ####
// ############################
instance.prototype.init_variables = function () {
	this.setVariableDefinitions(variables.setVariables.bind(this)());
};

instance.prototype.checkVariables = function () {
	variables.checkVariables.bind(this)();
};

// ##########################
// #### Instance Presets ####
// ##########################
instance.prototype.init_presets = function () {
	this.setPresetDefinitions(presets.setPresets.bind(this)());
};

//Instance Actions
instance.prototype.makeCrosspoint = function(sourceChannelName, sourceDeviceName, destinationChannelNumber) {
	let self = this;

	self.DANTE.makeCrosspoint(sourceChannelName, sourceDeviceName, destinationChannelNumber);
};

instance.prototype.clearCrosspoint = function(destinationChannelNumber) {
	let self = this;

	self.DANTE.clearCrosspoint(destinationChannelNumber);
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;