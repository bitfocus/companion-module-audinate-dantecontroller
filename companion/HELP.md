# Audinate Dante Controller

This module controls Dante audio devices and routing in simple local networks.
It's based on Chris Ritsen's [Network audio controller](https://github.com/chris-ritsen/network-audio-controller) ( Python project)

## Config

- **Network card** — the interface on the Dante network. _Automatic_ uses whichever card reaches each
  device; picking one pins the module to it. The choice is stored by MAC address, so it survives an IP
  change (link-local or DHCP). If the card is missing, discovery still works but device settings stay
  empty and the connection reports an error.
- **Update Interval** — how often the module sweeps the network for devices (250 ms – 60 s, default
  1 s). Devices announce themselves when they appear, so this mainly sets how quickly one that has
  gone away is noticed.
- **Timeout Interval** — how long a device may go unheard before it is dropped (1 s – 5 min, default
  3 s). Dante hardware sends heartbeats several times a second and is unaffected; software endpoints
  are kept alive only by the sweep, so anything below twice the Update Interval is raised to it.
- **Create Module Variables** — on by default. Turn it off to skip the per-device variables and read
  the same values through the Device Property feedback instead.
- **Verbose Logging** — extra detail in the log, for troubleshooting.

## Actions

- Crosspoint - Clear
- Crosspoint - Clear (drop down menu)
- Crosspoint - Make
- Crosspoint - Make (drop down menu)
- Device Name - Reset
- Device Name - Set
- Device Name - Set (custom device)
- Encoding - Set
- Latency - Set
- Output Level - Set (currently only for AVIO 2out)
- Parameters - Refresh - re-reads names, routing and settings from one device or all of them. Devices
  announce their own changes, so this is only needed if one of those announcements is missed; they
  are multicast, and can be dropped on a congested network.
- Rx Channel Name - Reset
- Rx Channel Name - Set
- Sample Rate - Set
- Sample Rate - Set (custom)
- Sample Rate Pullup - Set
- Tx Channel Name - Reset
- Tx Channel Name - Set

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

- Channel - Subscription (_Value_)
- Crosspoint - Connected (_Boolean_)
- Crosspoint - Connected (manual) (_Boolean_)
- Device - Property (_Value_)
