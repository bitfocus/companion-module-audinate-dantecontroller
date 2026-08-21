# Audinate Dante Controller

This module controls Dante audio devices and routing in simple local networks.
It's based on Chris Ritsen's [Network audio controller](https://github.com/chris-ritsen/network-audio-controller) ( Python project)

## Config

- Select network interface
- Set poll interval time to discover from network
- Set response time before considering a device offline

## Actions

- Make Crosspoint
- Make Crosspoint (with dynamics drop-down choices)
- Clear Crosspoint
- Clear Crosspoint (with dynamics drop-down choices)
- Set Device Name
- Reset Device Name
- Set Tx Channel Name
- Reset Tx Channel Name
- Set Rx Channel Name
- Reset Rx Channel Name
- Set Sample Rate (with standard available Sample rates)
- Set Sample Rate (custom sample rate)
- Set Sample Rate Pullup
- Set Latency
- Set Encoding (bit depth)
- Set Output Level (currently only for AVIO 2out)

## Variables

### Global

- Device Names

### Per device

Named `<device name>_<suffix>`, so a device called `Amp-1` has `$(dante:Amp-1_sr)`.
The same values are available through the Device Property feedback.

- Dante model (`_dante_model`)
- Dante software build (`_dante_software_build`)
- Dante software version (`_dante_software_version`)
- Encoding (`_encoding`)
- Hardware build (`_hardware_build`)
- Hardware version (`_hardware_version`)
- IP address (`_ip`)
- Latency in ms (`_latency`)
- Locked (`_locked`)
- Manufacturer (`_manufacturer`)
- Manufacturer, short form (`_manufacturer_short`)
- Model name (`_model_name`)
- Output levels (`_output_levels`) - currently only for AVIO 2out
- Product version (`_product_version`)
- Receive channel count (`_rx`)
- Receive channel names (`_rx_names`)
- Sample rate (`_sr`)
- Sample rate pullup (`_pullup`)
- Software build (`_software_build`)
- Software version (`_software_version`)
- Transmit channel count (`_tx`)
- Transmit channel names (`_tx_names`)

## Feedbacks

- Crosspoint Connected (_Boolean_)
- Device Property (_Value_)
