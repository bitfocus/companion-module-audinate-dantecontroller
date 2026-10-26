# Audinate Dante Controller

This module controls Dante audio and video devices and routing in simple local networks.
It's based on Chris Ritsen's [Network audio controller](https://github.com/chris-ritsen/network-audio-controller) (Python project)

## Config

- **Network card** — the interface on the Dante network. _Automatic_ discovers on every card, including
  one plugged in later, and uses whichever card reaches each device; picking one pins the module to it. The choice is stored by MAC address, so it survives an IP
  change (link-local or DHCP). If the card is missing, discovery still works but device settings stay
  empty and the connection reports an error.
- **Update Interval** — how often the module sweeps the network for devices (250 ms – 60 s, default
  1 s). Devices announce themselves when they appear, so this mainly sets how quickly one that has
  gone away is noticed.
- **Timeout Interval** — how long a device may go unheard before it is dropped (1 s – 5 min, default
  3 s). Dante hardware sends heartbeats several times a second and is unaffected; software endpoints
  are kept alive only by the sweep, so anything below twice the Update Interval is raised to it.
- **Create Module Variables** — on by default. Turn it off to skip the per-device property variables and
  read the same values through the Device Property feedback instead.
- **Create Routing Variables** — on by default. Publishes each channel's name, each receive channel's
  subscription and whether it is connected, and each device's name. Router integrations such
  as Bitfocus Buttons read these. Only values that change are sent, so a large network costs little
  to keep up to date.
- **Verbose Logging** — extra detail in the log, for troubleshooting.

## Devices

Devices are identified by their Dante name, as Dante itself routes by name. Actions and feedbacks
store it, so a device that gets a new address keeps working, but renaming a device means pointing
its actions, feedbacks and variables at the new name. Actions saved by early versions hold an address
instead; those keep working while a device has that address. A replacement unit given the old name
takes over both the Dante subscriptions and the actions.

## Actions

Actions that pick from discovered devices and channels use drop-down menus. Those marked `(custom)`
take the same selection as free text instead, so it can be typed by hand or driven by a variable or
expression.

The crosspoint and channel-name actions carry a **Channel Type** option, _Audio_ or _Video_, and act
on that kind of channel only. Video is supported on Dante AV devices.

The crosspoint actions finish only once the device has taken the change: it acknowledges the command,
the receive channel reports the new subscription, and, for an audio source that is on the network,
the subscription connects. Otherwise the action fails with the reason - the device is offline or
locked, it rejected the command (with its result code), or it reports a subscription status such as
_unsupported_ for a self-route a device does not allow. A route to a device that is not on the network
succeeds once the receiver reports it, as Dante pre-patching does: it connects when the device appears.

_Crosspoint - Clear_'s "clear every channel" option follows the Channel Type as well: it clears every
channel of the selected type, not both. Use two actions to clear audio and video together.

- Crosspoint - Clear
- Crosspoint - Clear (custom)
- Crosspoint - Make
- Crosspoint - Make (custom)
- Device Name - Reset
- Device Name - Set
- Device Name - Set (custom)
- Encoding - Set
- Latency - Set
- Output Level - Set (currently only for AVIO 2out)
- Parameters - Refresh - re-reads names, routing and settings from one device or all of them. Devices
  announce their own changes, so this is only needed if one of those announcements is missed; they
  are multicast, and can be dropped on a congested network.
- Rx Channel Name - Reset
- Rx Channel Name - Set
- Sample Rate - Set
- Sample Rate - Set (custom) - takes any rate the device accepts, rather than the listed ones
- Sample Rate Pullup - Set
- Tx Channel Name - Reset
- Tx Channel Name - Set

## Variables

### Global

- Device Names

### Per device

Named `<device>_<suffix>`, where `<device>` is the device name with characters Companion cannot use
replaced by `_`, so a device called `Amp-1` has `$(dante:Amp-1_sr)` and one called `Stage Box` has
`$(dante:Stage_Box_sr)`. The same values are available through the Device Property feedback.

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
- Video receive channel count (`_rx_video`)
- Video receive channel names (`_rx_names_video`)
- Video transmit channel count (`_tx_video`)
- Video transmit channel names (`_tx_names_video`)

### Routing

Per device, with the same `<device>` prefix:

- Device name (`_device_name`) - the name as it is, which `<device>` cannot be turned back into
- Receive channel name (`_rx_<n>_name`, `_rx_video_<n>_name`)
- Receive channel source (`_rx_<n>_source`, `_rx_video_<n>_source`) - what the channel is subscribed
  to as `channel@device`, the names it subscribed with; empty when it is not subscribed
- Receive channel connected (`_rx_<n>_connected`, `_rx_video_<n>_connected`) - `true` only when the
  channel is subscribed and the receiver reports media arriving; `false` otherwise, including when it
  is not subscribed. A source shows in `_source` as soon as the receiver takes the subscription, even
  one it then refuses or cannot resolve - this says whether it is actually working, as Dante
  Controller's error marker does
- Receive channel status (`_rx_<n>_status`, `_rx_video_<n>_status`) - why, as the receiver reports
  it; empty when it is not subscribed. Audio shows the status code with its name, such as
  `connected (0x0009)`, `unresolved (0x0001)` (source not on the network, as with pre-patching) or
  `unsupported (0x001c)` (a refused self-route). Video shows `active`, `not active` (source found
  but sending nothing) or `unresolved`. Both update whenever the device reports a change, not only
  after an action
- Transmit channel name (`_tx_<n>_name`, `_tx_video_<n>_name`) - the name subscriptions use
- Channel label (`_rx_<n>_label`, `_tx_<n>_label` and the `_video_` forms) - how to show the channel:
  its name, or `Ch <n>` when it has none or only a placeholder such as `01 n/a` (which some devices,
  such as Neutrik NA2-D-LINE, report for an unnamed channel). The channel dropdowns use the same
  label. Display only: the `_name` variables keep the exact name, because Dante subscribes by it

## Feedbacks

- Channel - Subscription (_Value_)
- Crosspoint - Connected (_Boolean_)
- Crosspoint - Connected (custom) (_Boolean_)
- Device - Property (_Value_)

_Channel - Subscription_ and both _Crosspoint - Connected_ feedbacks take the same **Channel Type**
option as the actions, and report on that kind of channel only.
