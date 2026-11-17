import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const statusUrl = new URL('../htdocs/luci-static/resources/view/mtk_soc/status.js', import.meta.url);
const backendUrl = new URL('../root/usr/libexec/rpcd/luci.mtk_soc', import.meta.url);
const aclUrl = new URL('../root/usr/share/rpcd/acl.d/luci-app-mtk-soc.json', import.meta.url);
const status = await fs.readFile(statusUrl, 'utf8');
const backend = await fs.readFile(backendUrl, 'utf8');
const acl = JSON.parse(await fs.readFile(aclUrl, 'utf8'));

assert.match(status, /method:\s*'getDashboard'/);
assert.doesNotMatch(status, /callStatus|callPorts|callGdm|callPpeEntries/);
assert.match(status, /nextFast\s*=.*10000/);
assert.match(status, /nextGdm\s*=.*15000/);
assert.match(status, /nextPpe\s*=.*20000/);
assert.match(status, /status\.cpu_history/);
assert.doesNotMatch(status, /(?:label|title):\s*'cpu'\s*\+/);
assert.match(status, /label:\s*'CPU'\s*\+\s*coreIndex/);
assert.match(status, /title:\s*'CPU'\s*\+\s*core/);
assert.doesNotMatch(status, /\bWED\b|setFlowOffload|硬件卸载/);
assert.match(status, /id:\s*'mtk-cpu-governor'/);
assert.match(status, /id:\s*'mtk-cpu-maxfreq'/);
assert.match(status, /method:\s*'setCpuSettings'/);
assert.match(status, /@media\(max-width:900px\)\{\.mtk-split/);
assert.doesNotMatch(status, /function\s+errorPill/);
assert.match(status, /ioCounts\(port\.rx_errors,\s*port\.tx_errors\)/);
assert.match(status, /ioCounts\(port\.rx_dropped,\s*port\.tx_dropped\)/);
assert.match(status, /ioCounts\(entry\.rx_errors,\s*entry\.tx_errors\)/);
assert.match(status, /ioCounts\(entry\.rx_dropped,\s*entry\.tx_dropped\)/);
assert.match(status, /错误 RX \/ TX/);
assert.match(status, /丢包 RX \/ TX/);

assert.match(backend, /getDashboard.*scope/s);
assert.match(backend, /STATE_DIR=\/tmp\/mtk-soc/);
assert.match(backend, /HISTORY_MAX=120/);
assert.match(backend, /HISTORY_AGE=1200/);
assert.match(backend, /ppe_cache_ensure/);
assert.match(backend, /topology_ensure/);
assert.equal((backend.match(/\/sys\/kernel\/debug\/\$engine\/entries/g) || []).length, 2);
assert.ok(acl['luci-app-mtk-soc'].read.ubus['luci.mtk_soc'].includes('getDashboard'));
assert.ok(acl['luci-app-mtk-soc'].write.ubus['luci.mtk_soc'].includes('setCpuSettings'));

console.log('MediaTek SoC dashboard contract test: ok');
