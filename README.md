# luci-app-mtk-soc

LuCI status dashboard for MediaTek MT7988A routers running OpenWrt.

The package provides CPU load history and frequency controls, physical
Ethernet port counters, GDM/GMAC/PPE topology, PPE flow entries, thermal
sensors and fan status. It is designed for the Banana Pi BPI-R4, with a
generic fallback topology for other compatible devices.

## Features

- CPU utilization history with per-core `CPU0` through `CPU3` labels
- CPU governor and maximum-frequency controls
- Physical port link state, speed, traffic, errors and dropped packets
- Separate RX/TX error and drop counters in physical-port and GDM tables
- GDM, GMAC and PPE data-path visualization
- PPE engine counters and flow table with filtering and pagination
- CPU, SFP+ and fan thermal status
- Responsive desktop and mobile layouts
- Dark and light LuCI theme support

## Requirements

- OpenWrt with LuCI and `rpcd`
- `ubus`, `ubox`, `jshn` and BusyBox
- MediaTek MT7988A platform for the complete BPI-R4 topology
- Kernel debugfs for PPE flow entries

The package has been tested on OpenWrt 25.12.6 with Linux 6.18 on a Banana Pi
BPI-R4. Missing optional kernel interfaces are shown as unavailable without
breaking the rest of the page.

## Installation

Clone this repository directly into an OpenWrt build tree:

```sh
git clone https://github.com/pdww269/luci-app-mtk-soc.git \
  package/luci-app-mtk-soc
```

Select the package and build it:

```sh
make menuconfig
make package/luci-app-mtk-soc/compile V=s
```

The package is located under:

```text
LuCI -> Applications -> luci-app-mtk-soc
```

It can also be added as an external feed:

```text
src-git mtk_soc https://github.com/pdww269/luci-app-mtk-soc.git
```

Then run:

```sh
./scripts/feeds update mtk_soc
./scripts/feeds install -a -p mtk_soc
```

## Development

Run the repository checks with Node.js:

```sh
node --check htdocs/luci-static/resources/view/mtk_soc/status.js
node tests/dashboard-contract.mjs
node tests/null-nodes.mjs
```

The backend is a POSIX shell rpcd script:

```sh
sh -n root/usr/libexec/rpcd/luci.mtk_soc
```

## License

Apache License 2.0. See [LICENSE](LICENSE).

The UI component and design-system structure includes work derived from
[luci-app-airoha-npu](https://github.com/rchen14b/luci-app-airoha-npu) by
Ryan Chen, licensed under Apache-2.0. The dashboard layout was also adapted
from the `luci-app-naoki66-overview` r15 status page.
