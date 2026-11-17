'use strict';
'require view';
'require poll';
'require rpc';
'require ui';
'require view.mtk_soc.ui as aui';

/*
 * This LuCI DOM implementation stringifies null array entries. Normalize
 * conditional children before they reach E().
 */
var domCreate = window.E;

function compactNodes(nodes) {
	var out = [];
	(Array.isArray(nodes) ? nodes : [ nodes ]).forEach(function(node) {
		if (Array.isArray(node)) {
			compactNodes(node).forEach(function(child) {
				out.push(child);
			});
		} else if (node != null) {
			out.push(node);
		}
	});
	return out;
}

function E(tag, attrs, children) {
	if (!(attrs instanceof Object) || Array.isArray(attrs)) {
		children = attrs;
		attrs = null;
	}
	if (Array.isArray(children))
		children = compactNodes(children);
	return domCreate(tag, attrs, children);
}

var callDashboard = rpc.declare({
	object: 'luci.mtk_soc',
	method: 'getDashboard',
	params: [ 'scope' ],
	expect: {}
});

var callSetCpu = rpc.declare({
	object: 'luci.mtk_soc',
	method: 'setCpuSettings',
	params: [ 'governor', 'max_freq' ],
	expect: {}
});

var FREQ_KEY = 'mtk-soc.freq-history.v2';
var MAX_SAMPLES = 120;
var HISTORY_AGE = 20 * 60 * 1000;
var PPE_PAGE_SIZE = 50;

var GOVERNOR_LABELS = {
	conservative: '保守模式',
	ondemand: '按需模式',
	userspace: '用户空间',
	powersave: '省电模式',
	performance: '性能模式',
	schedutil: '调度模式'
};

var DUPLEX_LABELS = {
	full: '全双工',
	half: '半双工',
	unknown: '未知'
};

var CORE_COLORS = [
	'var(--ai-core-0)',
	'var(--ai-core-1)',
	'var(--ai-core-2)',
	'var(--ai-core-3)'
];

var PPE_ROLES = {
	ppe0: 'ESW / RJ45',
	ppe1: 'SFP+ LAN',
	ppe2: 'SFP+ WAN'
};

function nf(v) {
	return (v == null || isNaN(v) || Number(v) < 0) ? '—' : aui.nf(v);
}

function fmtMHz(khz) {
	return (khz == null || khz < 0) ? 'N/A' : Math.round(khz / 1000) + ' MHz';
}

function fmtHz(hz) {
	if (hz == null || hz < 0)
		return 'N/A';
	if (hz >= 1000000000)
		return (hz / 1000000000).toFixed(2).replace(/\.?0+$/, '') + ' GHz';
	return Math.round(hz / 1000000) + ' MHz';
}

function fmtTemp(mc) {
	return (mc == null || mc < 0) ? 'N/A' : (mc / 1000).toFixed(1) + ' °C';
}

function fmtBytes(v) {
	if (v == null || v < 0)
		return 'N/A';
	var units = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], n = Number(v), i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return (i ? n.toFixed(1) : String(n)) + ' ' + units[i];
}

function fmtClock(t) {
	var d = new Date(t);
	function p(n) { return (n < 10 ? '0' : '') + n; }
	return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtUptime(sec) {
	if (sec == null || sec < 0)
		return 'N/A';
	var d = Math.floor(sec / 86400);
	var h = Math.floor(sec % 86400 / 3600);
	var m = Math.floor(sec % 3600 / 60);
	var parts = [];
	if (d)
		parts.push(d + ' ' + _('天'));
	if (d || h)
		parts.push(h + ' ' + _('小时'));
	parts.push(m + ' ' + _('分'));
	return parts.join(' ');
}

function fmtRate(mbps) {
	var v = Number(mbps);
	if (!isFinite(v) || v <= 0)
		return 'N/A';
	if (v >= 1000)
		return (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'G';
	return v + 'M';
}

function governorLabel(v) {
	return GOVERNOR_LABELS[v] ? _(GOVERNOR_LABELS[v]) : (v || '-');
}

function duplexLabel(v) {
	return DUPLEX_LABELS[v] ? _(DUPLEX_LABELS[v]) : (v || _('未知'));
}

function loadStored(key, fallback) {
	try {
		var value = JSON.parse(sessionStorage.getItem(key) || 'null');
		return value == null ? fallback : value;
	} catch (e) {
		return fallback;
	}
}

function saveStored(key, value) {
	try {
		sessionStorage.setItem(key, JSON.stringify(value));
	} catch (e) {}
}

var loadHistory = [];
var freqHistory = loadStored(FREQ_KEY, []).filter(function(sample) {
	return sample && typeof sample.t === 'number' && typeof sample.f === 'number';
}).slice(-MAX_SAMPLES);
var latestStatus = {};
var latestPorts = [];
var currentPpeEntries = [];
var ppeStateFilter = '';
var ppeEngineFilter = '';
var ppeTypeFilter = '';
var ppePage = 0;
var lastSuccessAt = 0;

function latestCpuSample() {
	for (var i = loadHistory.length - 1; i >= 0; i--) {
		if (loadHistory[i] && loadHistory[i].u && loadHistory[i].u.length)
			return loadHistory[i];
	}
	return null;
}

function applyCpuHistory(status) {
	if (!Array.isArray(status.cpu_history))
		return;

	var now = Date.now();
	loadHistory = status.cpu_history.filter(function(sample) {
		return sample && isFinite(sample.t) && Array.isArray(sample.u) &&
			Number(sample.t) * 1000 >= now - HISTORY_AGE;
	}).map(function(sample) {
		return {
			t: Number(sample.t) * 1000,
			u: sample.u.map(function(value) {
				var n = Number(value);
				return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
			})
		};
	}).slice(-MAX_SAMPLES);
}

function pushFreq(khz) {
	var freq = Number(khz);
	if (!isFinite(freq) || freq <= 0)
		return;

	var now = Date.now();
	var last = freqHistory[freqHistory.length - 1];
	if (last && (now - last.t) < 1500)
		return;

	freqHistory.push({ t: now, f: freq });
	freqHistory = freqHistory.filter(function(sample) {
		return sample.t >= now - HISTORY_AGE;
	}).slice(-MAX_SAMPLES);
	saveStored(FREQ_KEY, freqHistory);
}

function latestValues(sample) {
	var values = [];
	var count = sample && sample.u ? sample.u.length : 0;
	for (var i = 0; i < count; i++)
		values.push(sample.u[i] == null ? null : sample.u[i]);
	return values;
}

function usageSummary() {
	var sample = latestCpuSample();
	if (!sample)
		return { avg: null, peak: null, peakCore: -1, sample: null };

	var sum = 0, count = 0, peak = null, peakCore = -1;
	for (var i = 0; i < sample.u.length; i++) {
		if (sample.u[i] == null)
			continue;
		sum += sample.u[i];
		count++;
		if (peak == null || sample.u[i] > peak) {
			peak = sample.u[i];
			peakCore = i;
		}
	}
	return {
		avg: count ? sum / count : null,
		peak: peak,
		peakCore: peakCore,
		sample: sample
	};
}

function ppeTotals(ppe) {
	ppe = ppe || {};
	var out = { total: 0, bound: 0, packets: 0, bytes: 0 };
	[ 'ppe0', 'ppe1', 'ppe2' ].forEach(function(name) {
		var engine = ppe[name] || {};
		out.total += Math.max(0, Number(engine.total) || 0);
		out.bound += Math.max(0, Number(engine.bound) || 0);
		out.packets += Math.max(0, Number(engine.packets) || 0);
		out.bytes += Math.max(0, Number(engine.bytes) || 0);
	});
	return out;
}

function activePortCount() {
	return latestPorts.filter(function(port) { return !!port.up; }).length;
}

function statePill(text, kind) {
	return aui.pill(text || '—', kind || '');
}

function portPill(port) {
	if (!port || !port.up)
		return statePill(_('未连接'), '');
	return statePill(_('已连接'), 'ok');
}

function ioCount(label, value) {
	var count = Math.max(0, Number(value) || 0);
	return E('span', {
		'class': 'mtk-io-count' + (count ? ' mtk-io-count--warn' : ''),
		title: label + ': ' + nf(count)
	}, [
		E('span', { 'class': 'mtk-io-count-label' }, label),
		E('span', { 'class': 'mtk-io-count-value' }, nf(count))
	]);
}

function ioCounts(rx, tx) {
	return E('span', { 'class': 'mtk-io-counts' }, [
		ioCount('RX', rx),
		ioCount('TX', tx)
	]);
}

function panel(title, body, cls) {
	return E('div', { 'class': 'mtk-panel' + (cls ? ' ' + cls : '') }, [
		E('div', { 'class': 'mtk-panel-head' }, [
			E('span', { 'class': 'mtk-panel-title' }, title)
		]),
		E('div', { 'class': 'mtk-panel-body' }, body)
	]);
}

function summaryTiles(status) {
	var s = status || {};
	var usage = usageSummary();
	var ppe = ppeTotals(s.ppe);
	var activePorts = activePortCount();
	var sfpOk = latestPorts.filter(function(port) {
		return port && port.up && (port.name === 'sfp-wan' || port.name === 'sfp-lan');
	}).length;
	var tempAccent = Number(s.cpu_temp_mc) >= Number(s.cpu_temp_warn_mc) ?
		'var(--ds-warn)' : 'var(--ds-ok)';

	return [
		aui.tile({
			id: 'mtk-summary-cpu',
			title: _('CPU 负载'),
			value: usage.avg == null ? '—' : aui.fmtPct(usage.avg),
			accent: 'var(--ai-cpu)',
			sub: usage.peak == null ? _('等待采样') :
				_('峰值') + ' CPU' + usage.peakCore + ' · ' + aui.fmtPct(usage.peak)
		}),
		aui.tile({
			id: 'mtk-summary-freq',
			title: _('当前频率'),
			value: fmtMHz(s.cpu_cur_freq).replace(' MHz', ''),
			unit: 'MHz',
			accent: 'var(--ds-ok)',
			sub: governorLabel(s.cpu_governor) + ' · ' +
				fmtMHz(s.cpu_min_freq) + ' - ' + fmtMHz(s.cpu_max_freq)
		}),
		aui.tile({
			id: 'mtk-summary-ppe',
			title: _('PPE 已绑定'),
			value: ppe.bound + ' / ' + ppe.total,
			accent: 'var(--ai-npu)',
			sub: aui.fmtK(ppe.packets) + ' ' + _('包') + ' · ' + fmtBytes(ppe.bytes)
		}),
		aui.tile({
			id: 'mtk-summary-temp',
			title: _('CPU 温度'),
			value: fmtTemp(s.cpu_temp_mc).replace(' °C', ''),
			unit: '°C',
			accent: tempAccent,
			sub: nf(s.cpu_count) + ' ' + _('核') + ' · ' + (s.kernel || '—')
		}),
		aui.tile({
			id: 'mtk-summary-uptime',
			title: _('运行时间'),
			value: fmtUptime(s.uptime),
			accent: 'var(--ds-info)',
			sub: (s.hostname || '—') + ' · ' + (s.compatible || '')
		}),
		aui.tile({
			id: 'mtk-summary-links',
			title: _('活动链路'),
			value: activePorts + ' / ' + latestPorts.length,
			accent: sfpOk === 2 ? 'var(--ds-ok)' : 'var(--ds-warn)',
			sub: _('SFP+') + ' ' + sfpOk + ' / 2 · ' + _('全部端口')
		})
	];
}

function renderSummary(status) {
	return E('div', { 'class': 'ai-grid ai-grid--tiles', id: 'mtk-summary-grid' },
		summaryTiles(status));
}

function svgEl(tag, attrs, children) {
	var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	Object.keys(attrs || {}).forEach(function(key) {
		if (attrs[key] != null)
			node.setAttribute(key, attrs[key]);
	});
	(children || []).forEach(function(child) {
		node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	});
	return node;
}

function lineChart(opts) {
	var samples = opts.samples || [];
	var min = opts.min, max = opts.max;
	var count = samples.length;
	var W = 1000, H = 320;
	var nodes = [];

	function x(i) { return count <= 1 ? 0 : i / (count - 1) * W; }
	function y(value) {
		return H - (Math.max(min, Math.min(max, value)) - min) / (max - min) * H;
	}

	(opts.grid || []).forEach(function(value) {
		nodes.push(svgEl('line', {
			x1: 0, y1: y(value).toFixed(1), x2: W, y2: y(value).toFixed(1),
			style: 'stroke:var(--ds-border);stroke-width:1;stroke-dasharray:3 5;vector-effect:non-scaling-stroke'
		}));
	});

	(opts.series || []).forEach(function(line) {
		var points = '';
		line.values.forEach(function(value, i) {
			if (value == null)
				return;
			points += (points ? ' ' : '') + x(i).toFixed(1) + ',' + y(value).toFixed(1);
		});
		if (points) {
			nodes.push(svgEl('polyline', {
				points: points,
				style: 'fill:none;stroke:' + line.color +
					';stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke'
			}));
		}
	});

	return svgEl('svg', {
		viewBox: '0 0 ' + W + ' ' + H,
		preserveAspectRatio: 'none',
		role: 'img',
		'aria-label': opts.label || ''
	}, nodes);
}

function chartBox(opts) {
	var plot = E('div', { 'class': 'mtk-chart-plot' });
	plot.appendChild(lineChart(opts));

	var labels = (opts.yLabels || []).map(function(item) {
		var top = (opts.max - item.v) / (opts.max - opts.min) * 100;
		return E('span', { style: 'top:' + top.toFixed(2) + '%' }, item.text);
	});
	if (labels.length)
		plot.appendChild(E('div', { 'class': 'mtk-chart-yaxis' }, labels));

	if (opts.tooltip) {
		var vline = E('div', { 'class': 'mtk-chart-vline' });
		var tip = E('div', { 'class': 'mtk-chart-tip' });
		plot.appendChild(vline);
		plot.appendChild(tip);
		plot.addEventListener('mousemove', function(ev) {
			var values = opts.samples || [];
			if (!values.length)
				return;
			var rect = plot.getBoundingClientRect();
			if (!rect.width)
				return;
			var ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
			var index = Math.round(ratio * (values.length - 1));
			var leftPct = values.length <= 1 ? 0 : index / (values.length - 1) * 100;
			vline.style.display = 'block';
			vline.style.left = leftPct + '%';
			tip.replaceChildren.apply(tip, opts.tooltip(index));
			tip.style.display = 'block';
			tip.style.left = Math.min(88, Math.max(12, leftPct)) + '%';
		});
		plot.addEventListener('mouseleave', function() {
			vline.style.display = 'none';
			tip.style.display = 'none';
		});
	}

	return E('div', { 'class': 'mtk-chart' }, [
		opts.legend || null,
		plot
	]);
}

function renderCpuChart() {
	var samples = loadHistory;
	var coreCount = samples.reduce(function(count, sample) {
		return Math.max(count, sample.u.length);
	}, 0);
	var series = [];
	var legendItems = [];

	for (var core = 0; core < coreCount; core++) {
		(function(coreIndex, color) {
			var values = samples.map(function(sample) {
				return sample.u[coreIndex] == null ? null : sample.u[coreIndex];
			});
			var latest = values.length ? values[values.length - 1] : null;
			series.push({ color: color, values: values });
			legendItems.push({
				label: 'CPU' + coreIndex,
				color: color,
				value: latest == null ? '—' : aui.fmtPct(latest)
			});
		})(core, CORE_COLORS[core % CORE_COLORS.length]);
	}

	return chartBox({
		samples: samples,
		min: 0,
		max: 100,
		grid: [ 0, 25, 50, 75, 100 ],
		yLabels: [
			{ v: 0, text: '0%' },
			{ v: 50, text: '50%' },
			{ v: 100, text: '100%' }
		],
		series: series,
		legend: aui.legend(legendItems),
		label: _('CPU 占用率历史'),
		tooltip: function(index) {
			var sample = samples[index];
			if (!sample)
				return [];
			var out = [ E('b', {}, fmtClock(sample.t)) ];
			for (var i = 0; i < sample.u.length; i++)
				out.push(E('div', {}, 'CPU' + i + ' · ' +
					(sample.u[i] == null ? '—' : aui.fmtPct(sample.u[i]))));
			return out;
		}
	});
}

function renderCoreBars(status) {
	var sample = latestCpuSample();
	var values = latestValues(sample);
	var count = Math.max(Number(status.cpu_count) || 0, values.length);
	var bars = [];

	for (var core = 0; core < count; core++) {
		var value = values[core];
		bars.push(aui.bar({
			title: 'CPU' + core,
			right: value == null ? '—' : aui.fmtPct(value),
			pct: value == null ? 0 : value,
			accent: CORE_COLORS[core % CORE_COLORS.length]
		}));
	}

	var loadavg = String(status.loadavg == null ? '' : status.loadavg).trim();
	return E('div', {}, [
		bars.length ? E('div', { 'class': 'mtk-core-bars' }, bars) : aui.empty(_('等待 CPU 采样')),
		E('div', { 'class': 'ai-kv mtk-cpu-facts' }, [
			E('div', { 'class': 'ai-kv-item' }, [
				E('span', { 'class': 'ai-kv-k' }, _('型号')),
				E('span', { 'class': 'ai-kv-v' }, status.cpu_model || '—')
			]),
			E('div', { 'class': 'ai-kv-item' }, [
				E('span', { 'class': 'ai-kv-k' }, _('平均负载')),
				E('span', { 'class': 'ai-kv-v' }, loadavg || '—')
			]),
			E('div', { 'class': 'ai-kv-item' }, [
				E('span', { 'class': 'ai-kv-k' }, _('NPU 时钟')),
				E('span', { 'class': 'ai-kv-v' }, fmtHz(status.clocks && status.clocks.npu_tops))
			]),
			E('div', { 'class': 'ai-kv-item' }, [
				E('span', { 'class': 'ai-kv-k' }, _('运行时间')),
				E('span', { 'class': 'ai-kv-v' }, fmtUptime(status.uptime))
			])
		])
	]);
}

function renderCpuControls(status, onApply) {
	var governor = E('select', {
		id: 'mtk-cpu-governor',
		class: 'cbi-input-select'
	}, (status.cpu_available_governors || []).map(function(value) {
		return E('option', {
			value: value,
			selected: value == status.cpu_governor ? '' : null
		}, governorLabel(value));
	}));

	var maxFreq = E('select', {
		id: 'mtk-cpu-maxfreq',
		class: 'cbi-input-select'
	}, (status.cpu_available_freqs || []).map(function(value) {
		return E('option', {
			value: value,
			selected: Number(value) == Number(status.cpu_max_freq) ? '' : null
		}, fmtMHz(Number(value)));
	}));

	var button = E('button', {
		type: 'button',
		class: 'ai-btn ai-btn--primary',
		click: function() {
			return onApply(governor.value, maxFreq.value);
		}
	}, _('应用'));

	return E('div', { 'class': 'mtk-cpu-control mtk-control-row' }, [
		E('label', { 'class': 'ai-field' }, [
			E('span', { 'class': 'ai-field-label' }, _('运行模式')),
			governor
		]),
		E('label', { 'class': 'ai-field' }, [
			E('span', { 'class': 'ai-field-label' }, _('最大频率')),
			maxFreq
		]),
		E('div', { 'class': 'mtk-control-meta' }, [
			E('span', {}, _('当前')),
			E('strong', { id: 'mtk-cpu-current-freq' }, fmtMHz(status.cpu_cur_freq))
		]),
		button
	]);
}

function renderPorts() {
	var rows = latestPorts.map(function(port) {
		return [
			E('div', {}, [
				E('strong', {}, port.name || '—'),
				E('div', { 'class': 'mtk-subtle' }, port.path || '—')
			]),
			portPill(port),
			E('span', { 'class': 'mtk-mono' }, port.up ?
				fmtRate(port.speed_mbps) + ' / ' + duplexLabel(port.duplex) : '—'),
			E('span', { 'class': 'mtk-mono' },
				fmtBytes(port.rx_bytes) + ' ↓ / ' + fmtBytes(port.tx_bytes) + ' ↑'),
			E('span', { 'class': 'mtk-mono' },
				nf(port.rx_packets) + ' ↓ / ' + nf(port.tx_packets) + ' ↑'),
			ioCounts(port.rx_errors, port.tx_errors),
			ioCounts(port.rx_dropped, port.tx_dropped)
		];
	});

	return aui.table({
		cols: [
			{ t: _('端口') },
			{ t: _('状态') },
			{ t: _('速率 / 双工') },
			{ t: _('流量') },
			{ t: _('数据包') },
			{ t: _('错误 RX / TX') },
			{ t: _('丢包 RX / TX') }
		],
		rows: rows,
		stack: true,
		mono: true,
		accent: activePortCount() ? 'var(--ds-ok)' : 'var(--ds-warn)',
		emptyText: _('暂无端口数据')
	});
}

function renderGdm(data) {
	var entries = (data && data.gdm) || [];
	var rows = entries.map(function(entry) {
		var state = !entry.up ? statePill(_('未连接'), '') :
			statePill(_('转发中'), 'ok');

		return [
			E('div', {}, [
				E('strong', {}, entry.gdm || '—'),
				E('div', { 'class': 'mtk-subtle' }, entry.path || entry.interface || '—')
			]),
			E('div', { 'class': 'mtk-path' }, [
				E('span', { 'class': 'mtk-path-node' }, entry.gmac || '—'),
				E('span', { 'class': 'mtk-path-arrow' }, '›'),
				E('span', { 'class': 'mtk-path-node mtk-path-node--dma' }, entry.gdm || '—'),
				E('span', { 'class': 'mtk-path-arrow' }, '›'),
				E('span', { 'class': 'mtk-path-node mtk-path-node--ppe' }, entry.ppe || '—')
			]),
			E('span', { 'class': 'mtk-mono' }, fmtRate(entry.speed_mbps)),
			E('span', { 'class': 'mtk-mono' }, fmtBytes(entry.rx_bytes) + ' / ' + fmtBytes(entry.tx_bytes)),
			state,
			ioCounts(entry.rx_errors, entry.tx_errors),
			ioCounts(entry.rx_dropped, entry.tx_dropped)
		];
	});

	return aui.table({
		cols: [
			{ t: _('GDM / 接口') },
			{ t: _('数据路径') },
			{ t: _('链路') },
			{ t: _('接收 / 发送') },
			{ t: _('状态') },
			{ t: _('错误 RX / TX') },
			{ t: _('丢包 RX / TX') }
		],
		rows: rows,
		stack: true,
		mono: true,
		accent: 'var(--ai-npu)',
		emptyText: _('暂无 GDM 数据')
	});
}

function thermalState(current, warn, crit, alarm) {
	if (current == null || current < 0)
		return statePill(_('未知'), '');
	if (Number(alarm) > 0 || (crit >= 0 && current >= crit))
		return statePill(_('临界'), 'error');
	if (warn >= 0 && current >= warn)
		return statePill(_('警告'), 'warn');
	return statePill(_('正常'), 'ok');
}

function renderThermal(status) {
	var rows = [
		[
			E('strong', {}, _('CPU')),
			E('span', { 'class': 'mtk-mono' }, fmtTemp(status.cpu_temp_mc)),
			E('span', { 'class': 'mtk-mono' },
				fmtTemp(status.cpu_temp_warn_mc) + ' / ' + fmtTemp(status.cpu_temp_crit_mc)),
			thermalState(status.cpu_temp_mc, status.cpu_temp_warn_mc,
				status.cpu_temp_crit_mc, 0)
		],
		[
			E('strong', {}, _('SFP+ WAN')),
			E('span', { 'class': 'mtk-mono' }, fmtTemp(status.sfp1_temp_mc)),
			E('span', { 'class': 'mtk-mono' },
				fmtTemp(status.sfp1_temp_max_mc) + ' / ' + fmtTemp(status.sfp1_temp_crit_mc)),
			thermalState(status.sfp1_temp_mc, status.sfp1_temp_max_mc,
				status.sfp1_temp_crit_mc, status.sfp1_temp_alarm)
		],
		[
			E('strong', {}, _('SFP+ LAN')),
			E('span', { 'class': 'mtk-mono' }, fmtTemp(status.sfp2_temp_mc)),
			E('span', { 'class': 'mtk-mono' },
				fmtTemp(status.sfp2_temp_max_mc) + ' / ' + fmtTemp(status.sfp2_temp_crit_mc)),
			thermalState(status.sfp2_temp_mc, status.sfp2_temp_max_mc,
				status.sfp2_temp_crit_mc, status.sfp2_temp_alarm)
		]
	];

	if (Number(status.fan_pwm) >= 0) {
		rows.push([
			E('strong', {}, _('风扇')),
			E('span', { 'class': 'mtk-mono' }, status.fan_pwm + ' / 255'),
			E('span', { 'class': 'mtk-mono' },
				Number(status.fan_rpm) >= 0 ? nf(status.fan_rpm) + ' RPM' : 'N/A'),
			statePill(_('运行中'), 'ok')
		]);
	}

	return aui.table({
		cols: [
			{ t: _('传感器') },
			{ t: _('当前') },
			{ t: _('限制 (警告 / 临界)') },
			{ t: _('状态') }
		],
		rows: rows,
		stack: true,
		mono: true,
		accent: 'var(--ds-info)'
	});
}

function renderPpeEngines(status) {
	var ppe = status.ppe || {};
	var cards = [ 'ppe0', 'ppe1', 'ppe2' ].map(function(name) {
		var engine = ppe[name] || {};
		var total = Math.max(0, Number(engine.total) || 0);
		var bound = Math.max(0, Number(engine.bound) || 0);
		var ratio = total ? bound / total * 100 : 0;

		return aui.card({
			name: name.toUpperCase(),
			tag: PPE_ROLES[name],
			accent: total ? 'var(--ai-npu)' : 'var(--ds-text-muted)',
			body: E('div', {}, [
				E('div', { 'class': 'mtk-engine-value' }, [
					E('strong', {}, String(bound)),
					E('span', {}, ' / ' + total)
				]),
				aui.bar({
					title: _('绑定率'),
					right: aui.fmtPct(ratio, 0),
					pct: ratio,
					accent: 'var(--ai-npu)'
				}),
				E('div', { 'class': 'ai-kv mtk-engine-kv' }, [
					E('div', { 'class': 'ai-kv-item' }, [
						E('span', { 'class': 'ai-kv-k' }, _('未绑定')),
						E('span', { 'class': 'ai-kv-v' }, nf(engine.unbound))
					]),
					E('div', { 'class': 'ai-kv-item' }, [
						E('span', { 'class': 'ai-kv-k' }, _('数据包')),
						E('span', { 'class': 'ai-kv-v' }, aui.fmtK(engine.packets))
					]),
					E('div', { 'class': 'ai-kv-item' }, [
						E('span', { 'class': 'ai-kv-k' }, _('字节')),
						E('span', { 'class': 'ai-kv-v' }, fmtBytes(engine.bytes))
					])
				])
			])
		});
	});

	return E('div', { 'class': 'ai-grid ai-grid--3' }, cards);
}

function ppeType(entry) {
	return String(entry.type || '').split(' ').slice(0, 2).join(' ');
}

function mergeFixed(fixed, dynamic) {
	var out = fixed.slice();
	(dynamic || []).forEach(function(item) {
		if (item && out.indexOf(item) < 0)
			out.push(item);
	});
	return out.sort();
}

function filteredPpeEntries() {
	return currentPpeEntries.filter(function(entry) {
		return (!ppeStateFilter || entry.state === ppeStateFilter) &&
			(!ppeEngineFilter || entry.engine === ppeEngineFilter) &&
			(!ppeTypeFilter || ppeType(entry) === ppeTypeFilter);
	});
}

function rerenderPpeTable() {
	var host = document.getElementById('mtk-ppe-table');
	if (host)
		host.replaceChildren(renderPpeTable());
}

function ppeSelect(label, value, values, setter) {
	var select = E('select', {
		class: 'cbi-input-select',
		change: function(ev) {
			setter(ev.target.value);
			ppePage = 0;
			rerenderPpeTable();
		}
	});
	select.appendChild(E('option', { value: '' }, _('全部')));
	(values || []).forEach(function(item) {
		select.appendChild(E('option', { value: item }, String(item)));
	});
	select.value = value || '';

	return E('label', { 'class': 'mtk-filter-field' }, [
		E('span', {}, label),
		select
	]);
}

function renderPpeTable() {
	var states = mergeFixed([ 'BND', 'UNB', 'FIN' ],
		Array.from(new Set(currentPpeEntries.map(function(entry) {
			return entry.state;
		}).filter(Boolean))));
	var engines = mergeFixed([ 'ppe0', 'ppe1', 'ppe2' ],
		Array.from(new Set(currentPpeEntries.map(function(entry) {
			return entry.engine;
		}).filter(Boolean))));
	var types = Array.from(new Set(currentPpeEntries.map(ppeType).filter(Boolean))).sort();
	var filtered = filteredPpeEntries();
	var pages = Math.max(1, Math.ceil(filtered.length / PPE_PAGE_SIZE));
	ppePage = Math.max(0, Math.min(ppePage, pages - 1));
	var pageRows = filtered.slice(ppePage * PPE_PAGE_SIZE, (ppePage + 1) * PPE_PAGE_SIZE);

	var toolbar = E('div', { 'class': 'mtk-table-toolbar' }, [
		ppeSelect(_('状态'), ppeStateFilter, states, function(value) {
			ppeStateFilter = value;
		}),
		ppeSelect(_('引擎'), ppeEngineFilter, engines, function(value) {
			ppeEngineFilter = value;
		}),
		ppeSelect(_('类型'), ppeTypeFilter, types, function(value) {
			ppeTypeFilter = value;
		}),
		E('span', { 'class': 'mtk-toolbar-spacer' }),
		E('span', { 'class': 'mtk-subtle mtk-mono' },
			filtered.length + ' / ' + currentPpeEntries.length),
		E('button', {
			type: 'button',
			class: 'ai-btn',
			disabled: ppePage <= 0 ? '' : null,
			click: function() {
				ppePage = Math.max(0, ppePage - 1);
				rerenderPpeTable();
			}
		}, '‹'),
		E('span', { 'class': 'mtk-page-count' }, (ppePage + 1) + ' / ' + pages),
		E('button', {
			type: 'button',
			class: 'ai-btn',
			disabled: ppePage + 1 >= pages ? '' : null,
			click: function() {
				ppePage = Math.min(pages - 1, ppePage + 1);
				rerenderPpeTable();
			}
		}, '›')
	]);

	var rows = pageRows.map(function(entry) {
		return [
			E('span', { 'class': 'mtk-mono' }, entry.engine || '—'),
			E('span', { 'class': 'mtk-mono' }, entry.index || '—'),
			entry.state === 'BND' ? statePill('BND', 'ok') :
				statePill(entry.state || '—', entry.state === 'UNB' ? 'warn' : ''),
			E('span', { 'class': 'mtk-mono' }, entry.type || '—'),
			E('span', { 'class': 'mtk-flow' }, entry.orig || '—'),
			E('span', { 'class': 'mtk-flow' }, entry.new_flow || '—'),
			E('span', { 'class': 'mtk-mono' }, nf(entry.packets)),
			E('span', { 'class': 'mtk-mono' }, fmtBytes(entry.bytes))
		];
	});

	return E('div', {}, [
		toolbar,
		aui.table({
			cols: [
				{ t: _('引擎') },
				{ t: _('索引') },
				{ t: _('状态') },
				{ t: _('类型') },
				{ t: _('原始连接') },
				{ t: _('新连接') },
				{ t: _('数据包'), num: true },
				{ t: _('字节'), num: true }
			],
			rows: rows,
			stack: true,
			mono: true,
			accent: 'var(--ai-npu)',
			emptyText: _('暂无 PPE 表项')
		})
	]);
}

function freshnessPill(failed) {
	if (!lastSuccessAt)
		return failed ? statePill(_('刷新失败'), 'error') : statePill(_('等待数据'), 'info');
	return failed ?
		statePill(_('保留') + ' ' + fmtClock(lastSuccessAt), 'warn') :
		statePill(_('已更新') + ' ' + fmtClock(lastSuccessAt), 'ok');
}

function updateFreshness(refs, failed) {
	if (refs.fresh)
		refs.fresh.replaceChildren(freshnessPill(failed));
}

function applyFast(refs, data) {
	var status = data.status || {};
	latestStatus = status;
	applyCpuHistory(status);
	pushFreq(status.cpu_cur_freq);

	if (data.ports)
		latestPorts = (data.ports.ports || []).slice();

	refs.summary.replaceChildren(renderSummary(status));
	refs.cpuChart.replaceChildren(renderCpuChart());
	refs.cpuCores.replaceChildren(renderCoreBars(status));
	refs.ports.replaceChildren(renderPorts());
	refs.thermal.replaceChildren(renderThermal(status));
	refs.ppeEngines.replaceChildren(renderPpeEngines(status));

	var currentFreq = document.getElementById('mtk-cpu-current-freq');
	if (currentFreq)
		currentFreq.textContent = fmtMHz(status.cpu_cur_freq);
}

function applyGdm(refs, data) {
	if (data.gdm)
		refs.gdm.replaceChildren(renderGdm(data.gdm));
}

function applyPpe(refs, data) {
	var summary = data.summary && data.summary.ppe ? data.summary.ppe : (data.summary || {});
	var entries = data.entries || [];
	latestStatus = Object.assign({}, latestStatus, { ppe: summary });
	currentPpeEntries = entries.slice();
	refs.ppeEngines.replaceChildren(renderPpeEngines(latestStatus));
	refs.ppeTable.replaceChildren(renderPpeTable());
	refs.summary.replaceChildren(renderSummary(latestStatus));
}

function applyDashboard(refs, data) {
	data = data || {};
	if (data.status)
		applyFast(refs, data);
	if (data.gdm)
		applyGdm(refs, data);
	if (data.ppe)
		applyPpe(refs, data.ppe);

	if (Number(data.generated_at) > 0)
		lastSuccessAt = Number(data.generated_at);
	updateFreshness(refs, false);
}

function refreshAll(refs, manual) {
	var requests = [
		callDashboard('fast'),
		callDashboard('gdm'),
		callDashboard('ppe')
	];
	return Promise.all(requests).then(function(results) {
		results.forEach(function(result) {
			applyDashboard(refs, result);
		});
		if (manual)
			ui.addNotification(null, E('p', {}, _('状态已刷新')), 'info');
	}, function() {
		updateFreshness(refs, true);
		if (manual)
			ui.addNotification(null, E('p', {}, _('刷新失败')), 'warning');
	});
}

function pollDashboard(refs) {
	if (pollDashboard.busy)
		return Promise.resolve();

	var now = Date.now();
	var requests = [];
	if (now >= (pollDashboard.nextFast || 0)) {
		requests.push(callDashboard('fast'));
		pollDashboard.nextFast = now + 10000;
	}
	if (now >= (pollDashboard.nextGdm || 0)) {
		requests.push(callDashboard('gdm'));
		pollDashboard.nextGdm = now + 15000;
	}
	if (now >= (pollDashboard.nextPpe || 0)) {
		requests.push(callDashboard('ppe'));
		pollDashboard.nextPpe = now + 20000;
	}
	if (!requests.length)
		return Promise.resolve();

	pollDashboard.busy = true;
	return Promise.all(requests).then(function(results) {
		results.forEach(function(result) {
			applyDashboard(refs, result);
		});
	}, function() {
		updateFreshness(refs, true);
	}).then(function() {
		pollDashboard.busy = false;
	});
}

return view.extend({
	load: function() {
		return callDashboard('all');
	},

	render: function(data) {
		var status = (data && data.status) || {};
		aui.ensureCss();

		var pageCss = [
			'.mtk-page{font-size:1.06em}',
			'.airoha-page .ai-section{margin-bottom:1.15rem;padding:0 0 1.15rem;border:0;border-bottom:1px solid var(--ds-border);border-radius:0;background:transparent;box-shadow:none}',
			'.airoha-page .ai-section-head{margin-bottom:.7rem;border-bottom:0}',
			'.airoha-page .ai-section-head h3{font-size:var(--ds-fs-lg);padding:.2em 0}',
			'.mtk-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}',
			'.mtk-page-title{margin:0;font-size:var(--ds-fs-2xl);line-height:1.15}',
			'.mtk-page-sub{margin:.35rem 0 0;color:var(--ds-text-muted);font-size:var(--ds-fs-sm)}',
			'.mtk-toolbar{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}',
			'.mtk-split{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(18rem,.8fr);gap:.8rem;align-items:stretch}',
			'.mtk-split--equal{grid-template-columns:repeat(2,minmax(0,1fr))}',
			'.mtk-panel{min-width:0;border:1px solid var(--ds-border);border-left:3px solid var(--ai-accent,var(--ds-border));border-radius:var(--ds-r-md);background:var(--ds-surface)}',
			'.mtk-panel-head{display:flex;align-items:center;min-height:2.4rem;padding:.35rem .75rem;border-bottom:1px solid var(--ds-border);background:var(--ds-surface-sunken)}',
			'.mtk-panel-title{font-size:var(--ds-fs-sm);font-weight:650}',
			'.mtk-panel-body{padding:.7rem .75rem}',
			'.mtk-chart{display:flex;flex-direction:column;min-height:0}',
			'.mtk-chart-plot{position:relative;height:15rem;min-height:12rem}',
			'.mtk-chart-plot>svg{position:absolute;inset:0;width:100%;height:100%}',
			'.mtk-chart-yaxis{position:absolute;inset:0;pointer-events:none;font-size:.82em;color:var(--ds-text-muted)}',
			'.mtk-chart-yaxis>span{position:absolute;left:2px;transform:translateY(-50%)}',
			'.mtk-chart-vline{position:absolute;top:0;bottom:0;width:1px;background:var(--ds-border-strong);display:none;pointer-events:none}',
			'.mtk-chart-tip{position:absolute;top:.35rem;transform:translateX(-50%);display:none;pointer-events:none;z-index:3;background:var(--ds-surface);border:1px solid var(--ds-border);border-radius:var(--ds-r-md);padding:.3rem .55rem;font-size:var(--ds-fs-xs);line-height:1.5;white-space:nowrap;box-shadow:0 3px 12px rgba(15,23,42,.16)}',
			'.mtk-core-bars{display:grid;gap:.5rem;margin-bottom:.8rem}',
			'.mtk-cpu-facts{grid-template-columns:1fr;margin-bottom:.8rem}',
			'.mtk-control-row{display:flex;align-items:flex-end;gap:.6rem;flex-wrap:wrap;padding-top:.8rem;border-top:1px solid var(--ds-border)}',
			'.mtk-control-row .ai-field{flex:1 1 11rem;align-items:stretch;flex-direction:column;gap:.25rem}',
			'.mtk-control-meta{display:flex;flex-direction:column;gap:.2rem;min-width:5.5rem;font-size:var(--ds-fs-xs);color:var(--ds-text-muted)}',
			'.mtk-control-meta strong{font-family:var(--ds-mono);font-size:var(--ds-fs-sm);color:var(--ds-text)}',
			'.mtk-engine-value{display:flex;align-items:baseline;gap:.2rem;margin-bottom:.55rem;font-family:var(--ds-mono);font-size:var(--ds-fs-2xl);font-weight:700;color:var(--ai-npu)}',
			'.mtk-engine-value span{font-size:.55em;color:var(--ds-text-muted)}',
			'.mtk-engine-kv{grid-template-columns:1fr;margin-top:.65rem}',
			'.mtk-table-toolbar{display:flex;align-items:flex-end;gap:.55rem;flex-wrap:wrap;margin-bottom:.65rem}',
			'.mtk-filter-field{display:flex;flex-direction:column;gap:.2rem;font-size:var(--ds-fs-xs);color:var(--ds-text-muted)}',
			'.mtk-filter-field select{min-width:7.5rem}',
			'.mtk-toolbar-spacer{flex:1}',
			'.mtk-page-count{min-width:3.5rem;text-align:center;font-family:var(--ds-mono);font-size:var(--ds-fs-xs)}',
			'.mtk-subtle{color:var(--ds-text-muted);font-size:var(--ds-fs-xs)}',
			'.mtk-mono{font-family:var(--ds-mono);font-variant-numeric:tabular-nums}',
			'.mtk-flow{min-width:16rem;font-family:var(--ds-mono);font-size:var(--ds-fs-xs);overflow-wrap:anywhere}',
			'.mtk-io-counts{display:inline-flex;align-items:center;gap:var(--ds-sp-2);white-space:nowrap}',
			'.mtk-io-count{display:inline-flex;align-items:baseline;gap:.18em;font-family:var(--ds-mono);font-size:var(--ds-fs-xs);color:var(--ds-text-muted)}',
			'.mtk-io-count--warn{color:var(--ds-warn);font-weight:650}',
			'.mtk-io-count-label{font-size:.88em;opacity:.82}',
			'.mtk-io-count-value{font-variant-numeric:tabular-nums}',
			'.mtk-path{display:flex;align-items:center;gap:.25rem;white-space:nowrap}',
			'.mtk-path-node{display:inline-flex;align-items:center;justify-content:center;min-width:3.4rem;padding:.12rem .35rem;border:1px solid var(--ds-border-strong);border-radius:var(--ds-r-sm);font-family:var(--ds-mono);font-size:var(--ds-fs-xs)}',
			'.mtk-path-node--dma{color:var(--ds-info);border-color:var(--ds-info-line);background:var(--ds-info-tint)}',
			'.mtk-path-node--ppe{color:var(--ai-npu);border-color:var(--ds-info-line);background:var(--ds-info-tint)}',
			'.mtk-path-arrow{color:var(--ds-text-muted)}',
			'.mtk-page .ai-table-wrap{max-height:32rem}',
			'.mtk-page .ai-table td{vertical-align:middle}',
			'@media(max-width:900px){.mtk-split,.mtk-split--equal{grid-template-columns:1fr}}',
			'@media(max-width:720px){.mtk-page-title{font-size:var(--ds-fs-xl)}.mtk-chart-plot{height:12rem}.mtk-table-toolbar{align-items:stretch}.mtk-filter-field{flex:1 1 7rem}.mtk-toolbar-spacer{display:none}.mtk-control-row{align-items:stretch}.mtk-control-row .ai-field{flex-basis:100%}.mtk-control-meta{flex:1 1 100%;min-width:0;flex-direction:row;justify-content:flex-end;align-items:baseline;gap:.35rem}.mtk-control-row .ai-btn{width:100%}}'
		].join('');

		var refs = {
			fresh: E('span'),
			summary: E('div', { id: 'mtk-summary' }),
			cpuChart: E('div', { id: 'mtk-cpu-chart' }),
			cpuCores: E('div', { id: 'mtk-cpu-cores' }),
			ports: E('div', { id: 'mtk-ports' }),
			gdm: E('div', { id: 'mtk-gdm' }),
			thermal: E('div', { id: 'mtk-thermal' }),
			ppeEngines: E('div', { id: 'mtk-ppe-engines' }),
			ppeTable: E('div', { id: 'mtk-ppe-table' })
		};

		var refreshButton = E('button', {
			type: 'button',
			class: 'ai-btn',
			click: function() {
				return refreshAll(refs, true);
			}
		}, _('刷新'));

		var cpuControls = E('div');
		var root = E('div', { 'class': 'cbi-map airoha-page mtk-page' }, [
			E('style', {}, pageCss),
			E('div', { 'class': 'mtk-page-head' }, [
				E('div', {}, [
					E('h2', { 'class': 'mtk-page-title' }, _('MediaTek SoC 状态')),
					E('p', { 'class': 'mtk-page-sub' }, [
						status.model || 'Banana Pi BPI-R4',
						' · MT7988A · ',
						status.build || _('PPE / DSA / CPU 实时概览')
					])
				]),
				E('div', { 'class': 'mtk-toolbar' }, [ refs.fresh, refreshButton ])
			]),
			E('div', { 'class': 'mtk-page-body' }, [
				aui.section({
					title: _('运行概览'),
					body: refs.summary
				}),
				aui.section({
					title: _('CPU'),
					body: E('div', {}, [
						E('div', { 'class': 'mtk-split' }, [
							panel(_('占用率历史'), refs.cpuChart,
								'mtk-panel--cpu-chart'),
							panel(_('核心与运行状态'), E('div', {}, [
								refs.cpuCores,
								cpuControls
							]))
						])
					])
				}),
				aui.section({
					title: _('以太网与 DSA'),
					body: E('div', {}, [
						panel(_('物理端口'), refs.ports),
						E('div', { style: 'height:.7rem' }),
						panel(_('GDM 数据通路'), refs.gdm)
					])
				}),
				aui.section({
					title: _('温度'),
					body: refs.thermal
				}),
				aui.section({
					title: _('PPE 硬件转发'),
					body: E('div', {}, [
						refs.ppeEngines,
						E('div', { style: 'height:.8rem' }),
						E('div', { 'class': 'mtk-panel' }, [
							E('div', { 'class': 'mtk-panel-head' }, [
								E('span', { 'class': 'mtk-panel-title' }, _('PPE 流表'))
							]),
							E('div', { 'class': 'mtk-panel-body' }, refs.ppeTable)
						])
					])
				})
			])
		]);

		cpuControls.appendChild(renderCpuControls(status, function(governor, maxFreq) {
			return callSetCpu(governor, maxFreq).then(function() {
				ui.addNotification(null, E('p', {}, _('CPU 设置已应用')), 'info');
				return callDashboard('fast').then(function(next) {
					applyDashboard(refs, next);
				});
			}, function() {
				ui.addNotification(null, E('p', {}, _('CPU 设置失败')), 'warning');
			});
		}));

		applyDashboard(refs, data);

		pollDashboard.nextFast = Date.now() + 10000;
		pollDashboard.nextGdm = Date.now() + 15000;
		pollDashboard.nextPpe = Date.now() + 20000;
		poll.add(L.bind(pollDashboard, this, refs), 5);

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
