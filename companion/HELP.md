# Audinate Dante Controller

This module controls Dante audio devices and routing in simple local networks.
It's based on Chris Ritsen's [Network audio controller](https://github.com/chris-ritsen/network-audio-controller) ( Python project)

## Config

* Select network interface 
* Set poll interval time to discover from network 
* Set response time before considering a device offline

## Actions

* Make Crosspoint
* Make Crosspoint (with dynamics drop-down choices)
* Clear Crosspoint
* Clear Crosspoint (with dynamics drop-down choices)
* Set Device Name
* Reset Device Name
* Set Tx Channel Name
* Reset Tx Channel Name
* Set Rx Channel Name
* Reset Rx Channel Name
* Set Sample Rate (with standard available Sample rates)
* Set Sample Rate (custom sample rate)
* Set Sample Rate Pullup
* Set Latency
* Set Encoding (bit depth)
* Set Output Level (currently only for AVIO 2out)

## Variables
### Global
* Device Names

### Per device :
* Ip address
* Rx Channel count
* Tx Channel count
* Rx Channel names
* Tx Channel names
* Sample Rate
* Sample Rate Pullup
* Latency
* Encoding
* Model Name
* Product version
* Output Level (for AVIO 2out)

## Feedbacks

* Change background if crosspoint is active
