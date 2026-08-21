# companion-module-audinate-dantecontroller

This module controls dante devices and routing in LAN

See HELP.md and LICENSE

## Development tools

### `tools/dante-rx-probe.mjs`

Dumps a device's live receive-channel routing straight off the wire, without going through
Companion. Useful for answering "what does real hardware actually report for this route?" — several
protocol details in this module were reverse-engineered, and this turns a guess into a measurement.

```sh
yarn probe                   # discover Dante devices on the network
yarn probe 169.254.120.183   # dump that device's rx channels
```

```
  ch  rx name          source device        source channel   status@12  subscription@14
  ------------------------------------------------------------------------------------------
   1  CH1             .                    AMP Mon 1        0x0000     0x0004 (4) connected/self
   2  CH2             TAV-MINEOLA22XLR-0c0 CH1              0x0301     0x0009 (9) connected/unicast
   3  CH3             TAV-MINEOLA22XLR-0c0 CH2              0x0301     0x000a (10) connected/multicast
   4  CH4                                                   0x0000     0x0000 (0)
```

`subscription@14` is the field the crosspoint feedbacks gate on, via `SUBSCRIPTION_STATUS` in
[src/const.ts](src/const.ts). If the probe reports a code as `NOT CONNECTED` while Dante Controller
shows the route as healthy, that code is missing from `SUBSCRIPTION_STATUS` — add it there, with a
note on the device and route type it came from.

Note that `status@12` is a separate field and is **not** a usable "is connected" signal: it reads
`0x0301` for a working cross-device route but `0x0000` for a working self-route.
