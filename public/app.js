// TunnelWatch 状态面板 — 前端逻辑
// - 拉 /api/devices 填充下拉
// - 拉 /api/latest 渲染卡片镜像
// - 拉 /api/history 渲染 4 张图
// - 60 秒自动刷新

import { feature } from 'topojson-client';
import { geoNaturalEarth1, geoPath } from 'd3-geo';

const REFRESH_MS = 60_000;
// 世界地图 TopoJSON 来源(importmap 把 d3-geo/topojson-client 解析到 jsdelivr ESM,JSON 走 fetch 避免 MIME 限制)
const WORLD_TOPO_URL = '/vendor/world-50m.json';
// Chart.js 不解析 CSS var(),要写 hex
const COLORS = {
  primary: '#0F4C81',
  primaryFill: 'rgba(15,76,129,0.10)',
  ok: '#22C55E',
  warn: '#F59E0B',
  err: '#EF4444',
  secondary: '#888888',
  secondaryFill: 'rgba(136,136,136,0.10)',
  gridLine: '#F0F0F0',
  axis: '#888888',
};
const CHART_PALETTE = [
  COLORS.primary, COLORS.ok, COLORS.warn, COLORS.err, '#7C3AED',
  '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#6366F1'
];

// ---------- 状态 ----------
let currentDevice = null;     // uuid
let currentHours = 24;        // 时间窗:24 / 168 / 720(24h / 7d / 30d)
let currentRegionSort = 'count';    // 按地区 排序:'count' 充裕在前(节点数降序) / 'latency' ⚡延迟快(p50 升序)
let currentRenewalSort = 'expiry';  // 续费建议榜 排序:'expiry' 快到期(到期天数升序) / 'score' 推荐高(综合分降序)
let charts = {
  okRate: null, subOkRate: null, traffic: null, latency: null,
  subConn: null, regionLatency: null, protocol: null,
  failCount: null, trafficRate: null,
};

// 时间窗 → 服务端桶大小(分钟)
const HOURS_BUCKET_MIN = { 24: 15, 168: 60, 720: 240 };
// 时间窗 → 卡片标题显示(24h / 7d / 30d)
const HOURS_LABEL = { 24: '24h', 168: '7d', 720: '30d' };
// regionStats key(emoji 头)→ ISO 3166-1 数字代码(用于世界地图国家定位)
const REGION_TO_ISO = {
  HK: '344', JP: '392', TW: '158', SG: '702', KR: '410',
  UK: '826', US: '840', IN: '356', AU: '036', DE: '276',
  MY: '458', TH: '764', VN: '704', TR: '792',
  CN: '156',
};
// 缓存最近一次 history fetch(7d/30d 地图复用)
let lastHistoryItems = null;
let lastHistoryHours = null;
// 缓存 world-atlas GeoJSON(50m,模块加载完就解析一次)
let worldGeoFeatures = null;
let bills = [];
let billSources = [];
let knownPayers = [];   // 从历史 bills 里聚合出来的去重支付人列表(下拉用)
let currentFilter = { paidFrom: '', paidTo: '', payers: [] };  // 活跃筛选条件
const sharedBillToken = new URLSearchParams(location.search).get('bill');
const sharedFilterToken = new URLSearchParams(location.search).get('share');
const isSharedView = !!sharedFilterToken;

// URL 参数: ?hours=24|168|720 — 让链接可携带视角(分享/截屏固定)
// ?device=<uuid> — 跳过 loadDevices 默认选择
(function readUrlParams() {
  const p = new URLSearchParams(location.search);
  const h = parseInt(p.get('hours') || '', 10);
  if ([24, 168, 720].includes(h)) currentHours = h;
  // device 通过 localStorage 间接控制(loadDevices 已读)
})();

// ---------- 入口 ----------
init();

async function init() {
  wireBilling();
  wireViewSwitcher();
  wireRegionSortSwitcher();
  wireRenewalSortSwitcher();
  syncViewSwitcherActive();   // URL 参数 / default 同步到按钮高亮
  updateChartTitles();   // 初始化时就把 {H} 占位符替换掉(默认 24h)
  updateBucketHint(HOURS_BUCKET_MIN[currentHours] || 15);
  await loadDevices();
  setInterval(refreshAll, REFRESH_MS);
}

function syncViewSwitcherActive() {
  const root = document.getElementById('view-switcher');
  if (!root) return;
  [...root.querySelectorAll('button[data-hours]')].forEach(b => {
    const active = parseInt(b.dataset.hours, 10) === currentHours;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function wireViewSwitcher() {
  const root = document.getElementById('view-switcher');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-hours]');
    if (!btn) return;
    const h = parseInt(btn.dataset.hours, 10);
    if (![24, 168, 720].includes(h) || h === currentHours) return;
    currentHours = h;
    [...root.querySelectorAll('button')].forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    updateChartTitles();
    refreshAll();   // refreshAll 末尾会调 renderWorldMapCard(避免重复 fetch)
  });
}

// "按地区" 卡片头右侧的 "充裕在前 / ⚡ 延迟快" 切换 — 切排序后只重渲这一张卡
function wireRegionSortSwitcher() {
  const root = document.getElementById('region-sort-switcher');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    const s = btn.dataset.sort;
    if (s === currentRegionSort) return;
    currentRegionSort = s;
    [...root.querySelectorAll('button')].forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderRegionCard();
  });
}

// "续费建议榜" 卡片头右侧的 "快到期 / 推荐高" 切换 — 切排序后只重渲这一张卡
function wireRenewalSortSwitcher() {
  const root = document.getElementById('renewal-sort-switcher');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    const s = btn.dataset.sort;
    if (s === currentRenewalSort) return;
    currentRenewalSort = s;
    [...root.querySelectorAll('button')].forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderRenewalCard();
  });
}

// 切视角时把 "24h 节点 OK 率" → "7d 节点 OK 率" 这种标题同步过来
function updateChartTitles() {
  const label = HOURS_LABEL[currentHours] || '24h';
  document.querySelectorAll('[data-hours-title]').forEach(el => {
    el.textContent = el.dataset.hoursTitle.replace('{H}', label);
  });
}

async function loadDevices() {
  try {
    const res = await fetch('/api/devices');
    const { devices } = await res.json();
    const sel = document.getElementById('device-select');
    sel.innerHTML = '';
    if (!devices || devices.length === 0) {
      sel.innerHTML = '<option value="">未授权设备</option>';
      setFooter('未授权设备 — wrangler d1 execute 注册 UUID', false);
      return;
    }
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.uuid;
      opt.textContent = d.name + ' · ' + d.uuid.slice(0, 8);
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      currentDevice = sel.value;
      localStorage.setItem('tw_device', currentDevice);
      refreshAll();
      if (!sharedBillToken && !isSharedView) loadBills();
      loadBillSources();
    });
    // 默认选上次记忆的,否则第一个
    const remembered = localStorage.getItem('tw_device');
    const target = devices.find(d => d.uuid === remembered) || devices[0];
    sel.value = target.uuid;
    currentDevice = target.uuid;
    await Promise.all([
      refreshAll(),
      sharedBillToken
        ? loadSharedBill(sharedBillToken)
        : isSharedView
          ? loadSharedFilter(sharedFilterToken)
          : loadBills(),
      loadBillSources(),
    ]);
  } catch (e) {
    setFooter('加载设备列表失败: ' + e.message, false);
  }
}

async function refreshAll() {
  if (!currentDevice) return;
  await Promise.all([
    renderMirror(),
    renderRenewalCard(),
    renderRegionCard(),
    renderProtocolChart(),
    renderCharts(currentHours),
  ]);
  renderWorldMapCard();
  setFooter('已刷新 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), true);
}

// ---------- 卡片镜像 ----------
async function renderMirror() {
  try {
    const res = await fetch(`/api/latest?device=${currentDevice}&kind=full`);
    if (res.status === 404) {
      setMirrorEmpty('该设备暂无 FULL 快照');
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const s = data.summary || {};
    const p = data.payload || {};
    const probeRes = await fetch(`/api/latest?device=${currentDevice}&kind=probe`);
    const probeData = probeRes.ok ? await probeRes.json() : null;
    const probeTs = probeData?.ts;

    // server name
    document.getElementById('mirror-server').innerHTML =
      renderStatusDot(s.online) + escapeHtml(s.serverName || '—');

    // update time — 用 probe 的最新时间(更频繁)
    const updateTs = probeTs || data.ts;
    document.getElementById('mirror-update').textContent = '更新于 ' + formatRelative(updateTs);

    // uid row:优先用 summary.uidStats(轻);没就退化到 payload.lines
    const uidRow = document.getElementById('mirror-uid-row');
    const summaryUidStats = s.uidStats;
    const uidColorMap = p.uidColorMap || {};
    let uidStatsRendered = null;
    if (summaryUidStats && Object.keys(summaryUidStats).length > 0) {
      uidStatsRendered = summaryUidStats;
    } else {
      const lines = p.lines || [];
      if (lines.length > 0) {
        uidStatsRendered = perUidLineStats(lines);
      }
    }
    if (!uidStatsRendered || Object.keys(uidStatsRendered).length === 0) {
      uidRow.innerHTML = '<span class="empty">— 暂无节点 —</span>';
    } else {
      uidRow.innerHTML = Object.entries(uidStatsRendered).map(([uid, st]) => {
        const color = uidColorMap[uid] != null ? intToHex(uidColorMap[uid]) : CHART_PALETTE[0];
        return `<span class="uid-chip">
          <span class="sq" style="background:${color}"></span>
          <b style="color:${color}">${escapeHtml(uid)}</b> ${st.ok}/${st.total}
        </span>`;
      }).join('');
    }

    // sub row:用 summary.subStats + subLoadSummary 算
    const subRow = document.getElementById('mirror-sub-row');
    const subStats = s.subStats;
    const subLoadSummary = s.subLoadSummary || '';
    if (subStats) {
      // 用 subLoadSummary 拆出"6/6 OK"或"4/6 OK · 失败 2"
      const match = subLoadSummary.match(/(\d+)\/(\d+)\s*OK/);
      const ok = subStats.ok;
      const total = (ok + subStats.timeout + subStats.failed);
      const flag = match ? `${ok}/${total} OK` : subLoadSummary;
      subRow.innerHTML = `<span class="sub-chip">
        <span class="dot" style="background:${ok === total ? COLORS.ok : (subStats.failed > 0 ? COLORS.err : COLORS.warn)}"></span>
        ${escapeHtml(flag)}
        ${subStats.timeout > 0 ? `· <span style="color:${COLORS.warn}">${subStats.timeout} 超时</span>` : ''}
        ${subStats.failed > 0 ? `· <span style="color:${COLORS.err}">${subStats.failed} 失败</span>` : ''}
      </span>`;
    } else {
      // 退化:从 payload.subscriptions 算
      const subs = p.subscriptions || [];
      if (subs.length === 0) {
        subRow.innerHTML = '<span class="empty">— 暂无订阅源 —</span>';
      } else {
        subRow.innerHTML = subs.map(sub => {
          const flag = (sub.flag || '').slice(0, 6) || '—';
          const conn = sub.connectivity;
          const status = conn?.status || 'OK';
          const dotColor = status === 'OK' ? COLORS.ok : (status === 'TIMEOUT' ? COLORS.warn : COLORS.err);
          return `<span class="sub-chip">
            <span class="dot" style="background:${dotColor}"></span>
            ${escapeHtml(flag)}
          </span>`;
        }).join('');
      }
    }

    // meta: traffic + expire
    const meta = document.getElementById('mirror-meta');
    const parts = [];
    if (s.quotaUsedGB != null && s.quotaTotalGB != null) {
      const remain = Math.max(0, s.quotaTotalGB - s.quotaUsedGB);
      parts.push(`<span>流量 <b>${s.quotaUsedGB.toFixed(1)}</b> / ${s.quotaTotalGB.toFixed(0)} GB</span>`);
      parts.push(`<span>剩 ${remain.toFixed(1)} GB</span>`);
    }
    if (s.usagePercent != null) {
      parts.push(`<span>已用 ${s.usagePercent.toFixed(1)}%</span>`);
    }
    if (s.expireAtMillis) {
      parts.push(`<span>到期 ${formatDate(s.expireAtMillis)}</span>`);
    }
    if (s.subLoadSummary) {
      parts.push(`<span>${escapeHtml(s.subLoadSummary)}</span>`);
    }
    meta.innerHTML = parts.length ? parts.join(' · ') : '<span class="empty">—</span>';
  } catch (e) {
    setMirrorEmpty('加载失败: ' + e.message);
  }
}

function setMirrorEmpty(msg) {
  document.getElementById('mirror-server').innerHTML =
    '<span class="mirror-status-dot" style="background:var(--secondary)"></span>—';
  document.getElementById('mirror-update').textContent = msg;
  document.getElementById('mirror-uid-row').innerHTML = '';
  document.getElementById('mirror-sub-row').innerHTML = '';
  document.getElementById('mirror-meta').innerHTML = '';
}

// ---------- 按地区 卡片(PRIMARY · 合并"地区平衡 + 节点按地区") ----------
// 同一组 regionStats,一个排序状态,左右两段:ring chart + region info + 最快/最慢
async function renderRegionCard() {
  try {
    const res = await fetch(`/api/latest?device=${currentDevice}&kind=full`);
    if (!res.ok) {
      document.getElementById('region-list').innerHTML = '<span class="empty">— 暂无数据 —</span>';
      return;
    }
    const data = await res.json();
    const s = data.summary || {};
    const rs = s.regionStats || {};
    // total=0 的 region 跳过(等于"测了 0 个节点"=没这个地区)
    const entries = Object.entries(rs).filter(([_, v]) => v.total > 0);
    if (entries.length === 0) {
      document.getElementById('region-list').innerHTML = '<span class="empty">— 该设备未上传地区数据 —</span>';
      return;
    }
    // 状态派生:从 ok/total 推 — regionStats 没有 status 字段,自己算
    const statusOf = (v) => {
      if (v.total === 0) return 'missing';
      const r = v.ok / v.total;
      if (r >= 1) return 'abundant';
      if (r >= 0.8) return 'sufficient';
      if (r >= 0.5) return 'scarce';
      return 'missing';
    };
    const statusRank = { abundant: 3, sufficient: 2, scarce: 1, missing: 0 };
    // 排序:
    //   count(默认 · 充裕在前):total desc,然后 status desc
    //   latency(⚡ 延迟快):p50 asc(null 排到末尾),平手时 total desc
    if (currentRegionSort === 'latency') {
      entries.sort((a, b) => {
        const pa = a[1].p50, pb = b[1].p50;
        const aNull = pa == null, bNull = pb == null;
        if (aNull && bNull) return (b[1].total - a[1].total);
        if (aNull) return 1;          // null 排后
        if (bNull) return -1;
        if (pa !== pb) return pa - pb;
        return (b[1].total - a[1].total);
      });
    } else {
      // count(充裕在前):count desc,然后 status desc
      entries.sort((a, b) => {
        const dr = b[1].total - a[1].total;
        if (dr !== 0) return dr;
        return statusRank[statusOf(b[1])] - statusRank[statusOf(a[1])];
      });
    }
    // 切换 tab 时同步右侧 hint 文案
    const hint = document.getElementById('region-hint');
    if (hint) {
      hint.textContent = currentRegionSort === 'latency'
        ? '⚡ 延迟快 · p50 升序'
        : '充裕在前 · 节点数降序';
    }
    document.getElementById('region-list').innerHTML = entries.map(([region, v]) => {
      const pct = v.ok / v.total;          // 0~1
      const okPct = (pct * 100);
      const p50 = v.p50 != null ? `${v.p50}ms` : '—';

      // ring chart 颜色:按 OK 率分档
      //   100%  → 全绿(只有一段,不需要副色)
      //   >80%  → 绿 OK 段 + 浅灰失败段
      //   50-80% → 绿 OK 段 + 橙失败段
      //   <50%  → 绿 OK 段 + 红失败段
      const R = 16;                       // ring radius
      const C = 2 * Math.PI * R;          // circumference
      const okLen = (pct * C).toFixed(2);
      const failLen = (C - pct * C).toFixed(2);
      let failColor = '#E5E7EB';           // 浅灰(>80%)
      if (pct < 0.5) failColor = COLORS.err;
      else if (pct < 0.8) failColor = COLORS.warn;
      // 全绿时只画一段;否则 OK 段在前(从 12 点方向顺时针),失败段接上
      const ringSvg = (pct >= 1)
        ? `<svg viewBox="0 0 40 40" width="44" height="44">
             <circle cx="20" cy="20" r="${R}" fill="none" stroke="${COLORS.ok}" stroke-width="3.5"/>
           </svg>`
        : `<svg viewBox="0 0 40 40" width="44" height="44">
             <circle cx="20" cy="20" r="${R}" fill="none" stroke="${failColor}" stroke-width="3.5"/>
             <circle cx="20" cy="20" r="${R}" fill="none" stroke="${COLORS.ok}" stroke-width="3.5"
                     stroke-dasharray="${okLen} ${failLen}" stroke-dashoffset="${(C / 4).toFixed(2)}"
                     transform="rotate(-90 20 20)" stroke-linecap="butt"/>
           </svg>`;

      // 最快/最慢 — 0 OK 时都为 null
      const fast = v.fastest && typeof v.fastest === 'object' ? v.fastest : null;
      const slow = v.slowest && typeof v.slowest === 'object' ? v.slowest : null;
      let fsBlock = '';
      if (fast && slow) {
        // 差距条:p50 在 [fastest, slowest] 之间的位置百分比
        let markerPct = 0;
        if (v.p50 != null && slow.latency > fast.latency) {
          markerPct = ((v.p50 - fast.latency) / (slow.latency - fast.latency)) * 100;
          markerPct = Math.max(0, Math.min(100, markerPct));
        }
        const ratio = slow.latency > 0
          ? (slow.latency / Math.max(1, fast.latency)).toFixed(1) + 'x'
          : '—';
        const p50Title = v.p50 != null ? v.p50 + 'ms' : '—';
        fsBlock = `
          <div class="rr-fs-line">
            <span class="fs-fast">⚡ ${fast.latency}ms</span>
            <span class="fs-name" title="${escapeHtml(fast.name)}">${escapeHtml(fast.name)}</span>
            <span style="color:var(--secondary,#888);">·</span>
            <span class="fs-slow">🐌 ${slow.latency}ms</span>
            <span class="fs-name" title="${escapeHtml(slow.name)}">${escapeHtml(slow.name)}</span>
            <span class="fs-ratio">▲ ${ratio}</span>
          </div>
          <div class="fs-bar-wrap">
            <span class="fs-bar" title="p50 ${p50Title} 落在 [${fast.latency}, ${slow.latency}] ms">
              ${v.p50 != null ? `<span class="marker" style="left:${markerPct.toFixed(0)}%"></span>` : ''}
            </span>
            <span class="fs-range">${fast.latency}─${slow.latency} ms</span>
          </div>`;
      } else {
        // 全失败 / 单节点(没有差异)→ 只显示 "—"
        fsBlock = `<div class="rr-fs-line"><span class="fs-ratio">—</span></div>`;
      }

      return `<div class="region-row">
        <div class="rr-ring" title="${v.ok}/${v.total} OK · ${okPct.toFixed(0)}%">
          ${ringSvg}
          <span class="rr-ring-label">${v.ok}/${v.total}</span>
        </div>
        <div class="rr-info">
          <div class="rr-name" title="${escapeHtml(region)}">${escapeHtml(region)}</div>
          <div class="rr-p50">p50 ${p50}</div>
        </div>
        <div class="rr-fs">${fsBlock}</div>
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('region-list').innerHTML = '<span class="empty">加载失败: ' + e.message + '</span>';
  }
}

// ---------- 协议分布(pie) ----------
async function renderProtocolChart() {
  try {
    const res = await fetch(`/api/latest?device=${currentDevice}&kind=full`);
    if (!res.ok) return;
    const data = await res.json();
    const ps = data.summary?.protocolStats || {};
    const entries = Object.entries(ps);
    if (entries.length === 0) return;
    const labels = entries.map(([k]) => k);
    const values = entries.map(([_, v]) => v);
    const colors = entries.map(([_, i]) => CHART_PALETTE[i % CHART_PALETTE.length]);
    chartUpdate('chart-protocol', 'protocol', {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#FFFFFF', borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, font: { size: 12 }, color: COLORS.axis } },
          tooltip: { backgroundColor: '#1A1F2E', padding: 10 }
        }
      }
    });
  } catch (e) {
    console.error('renderProtocolChart failed:', e);
  }
}

// ---------- 续费建议榜(PRIMARY) ----------
async function renderRenewalCard() {
  try {
    const res = await fetch(`/api/latest?device=${currentDevice}&kind=probe`);
    if (!res.ok) {
      document.getElementById('renewal-list').innerHTML = '<span class="empty">— 暂无数据 —</span>';
      return;
    }
    const data = await res.json();
    const scores = data.summary?.subscriptionScores || [];
    if (scores.length === 0) {
      document.getElementById('renewal-list').innerHTML = '<span class="empty">— 该设备未上传续费数据 —</span>';
      return;
    }
    const renewBadge = { renew: '✓ 续费', consider: '⚠ 考虑', replace: '✗ 换掉' };
    const renewColor = {
      renew: COLORS.ok,
      consider: COLORS.warn,
      replace: COLORS.err,
    };
    // 排序:
    //   expiry(默认 · 快到期):daysToExpire asc(长期有效排后,平手按 score desc)
    //   score(推荐高):score desc(平手按 daysToExpire asc)
    const sortedScores = scores.slice().sort((a, b) => {
      if (currentRenewalSort === 'score') {
        const ds = (b.score ?? 0) - (a.score ?? 0);
        if (ds !== 0) return ds;
        const ad = a.daysToExpire == null ? Infinity : a.daysToExpire;
        const bd = b.daysToExpire == null ? Infinity : b.daysToExpire;
        return ad - bd;
      } else {
        // expiry
        const ad = a.daysToExpire == null ? Infinity : a.daysToExpire;
        const bd = b.daysToExpire == null ? Infinity : b.daysToExpire;
        if (ad !== bd) return ad - bd;
        return (b.score ?? 0) - (a.score ?? 0);
      }
    });
    // 切换 tab 时同步右侧 hint 文案
    const hint = document.getElementById('renewal-hint');
    if (hint) {
      hint.textContent = currentRenewalSort === 'score'
        ? '推荐高 · 综合分降序 · 实时(最新快照)'
        : '快到期 · 到期天数升序 · 实时(最新快照)';
    }
    document.getElementById('renewal-list').innerHTML = sortedScores.map(s => {
      const score = s.score ?? 0;
      const okPct = (s.okRate * 100).toFixed(0) + '%';
      const p50 = s.p50 != null ? `${s.p50}ms` : '—ms';
      const expireTxt = s.daysToExpire == null
        ? '长期'
        : (s.daysToExpire < 0
            ? `已过期 ${Math.abs(s.daysToExpire)} 天`
            : `${s.daysToExpire} 天后到期`);
      const expireColor = s.daysToExpire != null && s.daysToExpire < 14
        ? COLORS.warn
        : (s.daysToExpire != null && s.daysToExpire < 0 ? COLORS.err : COLORS.secondary);
      const unique = (s.uniqueValue || []);
      const uniqueLine = unique.length > 0
        ? `<div style="margin-top:4px;font-size:11px;color:${COLORS.primary};line-height:1.4;">
             补 ${unique.map(escapeHtml).join(' / ')}
           </div>`
        : '';
      return `<div class="renewal-row" style="
        display:flex;align-items:center;gap:10px;
        padding:10px 4px;border-bottom:1px solid var(--border);
      ">
        <div style="flex:0 0 88px;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(s.sub)}">${escapeHtml(s.sub)}</div>
        </div>
        <div style="flex:0 0 64px;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:${renewColor[s.recommend] || COLORS.secondary};font-variant-numeric:tabular-nums;line-height:1;">${score}</div>
          <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-top:4px;">
            <div style="height:100%;background:${renewColor[s.recommend] || COLORS.secondary};width:${Math.max(0, Math.min(100, score))}%;"></div>
          </div>
        </div>
        <div style="flex:0 0 56px;text-align:center;">
          <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#FFFFFF;background:${renewColor[s.recommend] || COLORS.secondary};">${renewBadge[s.recommend] || '?'}</span>
        </div>
        <div style="flex:1;min-width:0;font-size:11px;color:var(--meta);line-height:1.5;">
          <div>OK ${okPct} · p50 ${p50} · ${s.nodeCount} 节点 · ${s.regionCount} 地区</div>
          <div style="margin-top:2px;color:${expireColor};">到期 ${escapeHtml(expireTxt)}</div>
          ${uniqueLine}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('renewal-list').innerHTML = '<span class="empty">加载失败: ' + e.message + '</span>';
  }
}

// ---------- 8 张 24h 趋势图(监测的核心价值) ----------
// hours: 24 / 168 / 720 — 控制时间窗,服务端按对应 bucket 预聚合
async function renderCharts(hours = 24) {
  const bucketMin = HOURS_BUCKET_MIN[hours] || 15;
  try {
    const res = await fetch(`/api/history?device=${currentDevice}&hours=${hours}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { items } = await res.json();
    // 缓存给世界地图复用(7d/30d 视角下 regionStats 不来自 /latest,要从 history 取)
    lastHistoryItems = items;
    lastHistoryHours = hours;
    // 服务端已按 bucket GROUP BY,每桶一个数据点;客户端再 dedup 是 no-op,但保留以防混 kind
    drawOkRate(items, bucketMin);
    drawSubOkRate(items, bucketMin);
    drawTraffic(items, bucketMin);
    drawLatency(items, bucketMin);
    drawSubConn(items, bucketMin);
    drawRegionLatency(items, bucketMin);
    drawFailCount(items, bucketMin);
    drawTrafficRate(items, bucketMin);
    // 同步"按 N 分钟桶"提示
    updateBucketHint(bucketMin);
  } catch (e) {
    console.error('renderCharts failed:', e);
  }
}

function updateBucketHint(bucketMin) {
  const label = bucketMin >= 60 ? `${bucketMin / 60}h` : `${bucketMin}m`;
  document.querySelectorAll('[data-bucket-hint]').forEach(el => {
    el.textContent = el.dataset.bucketHint.replace('{B}', label);
  });
}

function drawOkRate(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    const key = bucketKey(it.ts, bucketMin);
    if (it.kind === 'probe' || !byTs.has(key)) byTs.set(key, it);
  });
  const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const uidSet = new Set();
  sorted.forEach(it => {
    const s = it.summary || {};
    (s.uidStats ? Object.keys(s.uidStats) : s.uidTags || []).forEach(u => uidSet.add(u));
  });
  const uids = [...uidSet];
  const labels = sorted.map(it => formatTime(it.ts, currentHours));
  const datasets = uids.map((uid, i) => {
    const data = sorted.map(it => {
      const s = it.summary || {};
      if (s.uidStats && s.uidStats[uid]) {
        const st = s.uidStats[uid];
        return st.total > 0 ? (st.ok / st.total) * 100 : null;
      }
      if (s.uidTags && s.uidTags.includes(uid) && s.lineTotalCount) {
        return (s.lineOkCount / s.lineTotalCount) * 100;
      }
      return null;
    });
    return {
      label: uid, data,
      borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
      backgroundColor: 'transparent',
      tension: 0.25, spanGaps: true,
      pointRadius: 2, pointHoverRadius: 4,
    };
  });
  chartUpdate('chart-ok-rate', 'okRate', {
    type: 'line', data: { labels, datasets },
    options: chartOpts({ y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } })
  });
}

function drawSubOkRate(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    const key = bucketKey(it.ts, bucketMin);
    if (it.kind === 'probe' || !byTs.has(key)) byTs.set(key, it);
  });
  const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const subSet = new Set();
  sorted.forEach(it => {
    const s = it.summary || {};
    if (s.subLineStats) Object.keys(s.subLineStats).forEach(u => subSet.add(u));
  });
  const subs = [...subSet];
  const flagOf = (url) => {
    for (const it of sorted) {
      const s = it.summary || {};
      if (s.subLineStats && s.subLineStats[url] && s.subLineStats[url].flag) {
        return s.subLineStats[url].flag.slice(0, 6);
      }
    }
    return url.replace(/^https?:\/\//, '').split('.')[0].slice(0, 6);
  };
  const labels = sorted.map(it => formatTime(it.ts, currentHours));
  const datasets = subs.map((url, i) => {
    const data = sorted.map(it => {
      const s = it.summary || {};
      if (s.subLineStats && s.subLineStats[url]) {
        const st = s.subLineStats[url];
        return st.total > 0 ? (st.ok / st.total) * 100 : null;
      }
      return null;
    });
    return {
      label: flagOf(url), data,
      borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
      backgroundColor: 'transparent',
      tension: 0.25, spanGaps: true,
      pointRadius: 2, pointHoverRadius: 4,
    };
  });
  chartUpdate('chart-sub-ok-rate', 'subOkRate', {
    type: 'line', data: { labels, datasets },
    options: chartOpts({ y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } })
  });
}

function drawTraffic(items, bucketMin) {
  const sorted = items
    .filter(it => it.kind === 'full' || (it.summary?.quotaUsedGB != null))
    .map(it => ({ ts: it.ts, s: it.summary || {} }));
  const byTs = new Map();
  sorted.forEach(it => byTs.set(bucketKey(it.ts, bucketMin), it));
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const used = series.map(it => it.s.quotaUsedGB);
  const total = series.map(it => it.s.quotaTotalGB);
  chartUpdate('chart-traffic', 'traffic', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '已用', data: used, borderColor: COLORS.primary, backgroundColor: COLORS.primaryFill, fill: true, tension: 0.25, pointRadius: 2 },
        { label: '总量', data: total, borderColor: COLORS.secondary, backgroundColor: 'transparent', borderDash: [4, 4], fill: false, tension: 0, pointRadius: 0 },
      ]
    },
    options: chartOpts({ y: { ticks: { callback: v => v + ' GB' } } })
  });
}

function drawLatency(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    if (it.summary?.latency) byTs.set(bucketKey(it.ts, bucketMin), it);
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const p50 = series.map(it => it.summary.latency.p50);
  const p95 = series.map(it => it.summary.latency.p95);
  chartUpdate('chart-latency', 'latency', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'p50', data: p50, borderColor: COLORS.primary, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2 },
        { label: 'p95', data: p95, borderColor: COLORS.warn, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2 },
      ]
    },
    options: chartOpts({ y: { beginAtZero: true, ticks: { callback: v => v + ' ms' } } })
  });
}

function drawRegionLatency(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    if (it.summary?.regionStats) {
      const key = bucketKey(it.ts, bucketMin);
      if (it.kind === 'probe' || !byTs.has(key)) byTs.set(key, it);
    }
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const regionCount = {};
  series.forEach(it => {
    Object.entries(it.summary.regionStats || {}).forEach(([r, v]) => {
      regionCount[r] = (regionCount[r] || 0) + v.total;
    });
  });
  const regions = Object.keys(series[0]?.summary?.regionStats || {})
    .sort((a, b) => (regionCount[b] || 0) - (regionCount[a] || 0))
    .slice(0, 8);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const datasets = regions.map((region, i) => {
    const data = series.map(it => {
      const st = it.summary.regionStats?.[region];
      if (!st) return null;
      const p50 = st.p50;
      return (p50 != null && typeof p50 === 'number') ? p50 : null;
    });
    return {
      label: region, data,
      borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
      backgroundColor: 'transparent',
      tension: 0.25, spanGaps: true,
      pointRadius: 2, pointHoverRadius: 4,
    };
  });
  chartUpdate('chart-region-latency', 'regionLatency', {
    type: 'line', data: { labels, datasets },
    options: chartOpts({ y: { beginAtZero: true, ticks: { callback: v => v + ' ms' } } })
  });
}

function drawSubConn(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    if (it.summary?.subStats) byTs.set(bucketKey(it.ts, bucketMin), it);
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const ok = series.map(it => it.summary.subStats.ok);
  const timeout = series.map(it => it.summary.subStats.timeout);
  const failed = series.map(it => it.summary.subStats.failed);
  chartUpdate('chart-sub-conn', 'subConn', {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'OK', data: ok, backgroundColor: COLORS.ok, stack: 's' },
      { label: '超时', data: timeout, backgroundColor: COLORS.warn, stack: 's' },
      { label: '失败', data: failed, backgroundColor: COLORS.err, stack: 's' },
    ]},
    options: chartOpts({ y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } })
  });
}

function drawFailCount(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    const key = bucketKey(it.ts, bucketMin);
    if (it.kind === 'probe' || !byTs.has(key)) byTs.set(key, it);
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const failed = series.map(it => {
    const s = it.summary || {};
    if (typeof s.lineTotalCount === 'number' && typeof s.lineOkCount === 'number') {
      return Math.max(0, s.lineTotalCount - s.lineOkCount);
    }
    return null;
  });
  chartUpdate('chart-fail-count', 'failCount', {
    type: 'bar',
    data: { labels, datasets: [{ label: '失败节点数', data: failed, backgroundColor: COLORS.err, borderRadius: 4 }] },
    options: chartOpts({ y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } })
  });
}

function drawTrafficRate(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    if (it.kind === 'full' || !byTs.has(bucketKey(it.ts, bucketMin))) {
      byTs.set(bucketKey(it.ts, bucketMin), it);
    }
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const used = series.map(it => it.summary?.quotaUsedGB);
  const rate = used.map((v, i) => {
    if (v == null || i === 0) return null;
    const prev = used[i - 1];
    if (prev == null) return null;
    return Math.max(0, +(v - prev).toFixed(2));
  });
  chartUpdate('chart-traffic-rate', 'trafficRate', {
    type: 'bar',
    data: { labels, datasets: [{ label: '增量 (GB)', data: rate, backgroundColor: COLORS.primary, borderRadius: 4 }] },
    options: chartOpts({ y: { beginAtZero: true, ticks: { callback: v => v + ' GB' } } })
  });
}

// ---------- 世界地图(按地区 p50 染色) ----------
// 24h → /api/latest summary.regionStats(当前快照)
// 7d/30d → 用 renderCharts 已经 fetch 的 history items,取最新一桶的 regionStats
async function renderWorldMapCard() {
  const svg = document.getElementById('world-map');
  const hint = document.getElementById('world-map-hint');
  const tip = document.getElementById('world-map-tip');
  if (!svg) return;
  if (hint) hint.textContent = `${HOURS_LABEL[currentHours] || '24h'} · 按地区 p50 染色`;

  if (!currentDevice) return;

  // 1. 拿到当前视角的 regionStats
  let rs = null;
  if (currentHours === 24) {
    try {
      const res = await fetch(`/api/latest?device=${currentDevice}&kind=full`);
      if (!res.ok) return;
      const data = await res.json();
      rs = data.summary?.regionStats || null;
    } catch (e) {
      console.error('world map latest fetch failed:', e);
      return;
    }
  } else {
    // 7d/30d — 复用 renderCharts 缓存,取最新一桶
    if (!lastHistoryItems || lastHistoryHours !== currentHours) {
      // 没缓存就 fetch 一次
      try {
        const res = await fetch(`/api/history?device=${currentDevice}&hours=${currentHours}`);
        if (!res.ok) return;
        const { items } = await res.json();
        lastHistoryItems = items;
        lastHistoryHours = currentHours;
      } catch (e) {
        console.error('world map history fetch failed:', e);
        return;
      }
    }
    const sorted = [...lastHistoryItems].sort((a, b) => b.ts - a.ts);
    const latestWithRegions = sorted.find(it => it.summary?.regionStats);
    rs = latestWithRegions?.summary?.regionStats || null;
  }
  if (!rs) return;

  // 2. 解 TopoJSON → GeoJSON(只做一次,后续复用)— 改用 fetch 而非静态 import
  if (!worldGeoFeatures) {
    try {
      const worldRes = await fetch(WORLD_TOPO_URL);
      if (!worldRes.ok) throw new Error('HTTP ' + worldRes.status);
      const worldData = await worldRes.json();
      worldGeoFeatures = feature(worldData, worldData.objects.countries).features;
    } catch (e) {
      console.error('world map topology fetch failed:', e);
      return;
    }
  }

  // 3. 颜色档位
  const colorByP50 = (v) => {
    if (v == null || (v.total != null && v.total > 0 && v.ok === 0 && v.p50 == null)) {
      return { fill: '#9CA3AF', title: '不可用' };
    }
    if (v.p50 == null) return { fill: '#9CA3AF', title: '不可用' };
    if (v.p50 < 50) return { fill: COLORS.ok, title: `${v.p50}ms · 优` };
    if (v.p50 < 150) return { fill: COLORS.warn, title: `${v.p50}ms · 中` };
    return { fill: COLORS.err, title: `${v.p50}ms · 差` };
  };

  // 4. 把 regionStats key("🇭🇰 HK" 等)归一化成 {ISO → 第一个匹配 region(其余合并)}
  //   - 一个 ISO 可能被多个 region 匹配(理论上不该出现,先收集所有)
  //   - "🌐 其他" 单独走中国色块(ISO 156)
  const isoToRegionInfo = new Map();
  Object.entries(rs).forEach(([region, v]) => {
    if (v.total == null || v.total === 0) return;
    // 剥掉 emoji(用 code-point-aware 的方式,flag 是两个 regional indicator)
    const code = region.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim().toUpperCase();
    let iso = REGION_TO_ISO[code];
    if (!iso) {
      // 未知 region(比如 "🌐 其他")→ 落到中国(ISO 156)
      iso = REGION_TO_ISO.CN;
    }
    const okRate = v.total > 0 ? v.ok / v.total : 0;
    const info = { region, v, p50: v.p50, okRate, color: null, title: null };
    const c = colorByP50(v);
    info.color = c.fill;
    info.title = c.title;
    // 同一 ISO 取"节点数最多"的那个代表
    const prev = isoToRegionInfo.get(iso);
    if (!prev || (v.total || 0) > (prev.v.total || 0)) {
      isoToRegionInfo.set(iso, info);
    }
  });

  // 5. 投影 + 生成 path
  const projection = geoNaturalEarth1().fitSize([960, 600], { type: 'Sphere' });
  const path = geoPath(projection);

  // 6. 渲染所有国家 path(先全画浅灰底,再覆盖有数据的国家)
  const paths = worldGeoFeatures.map(feat => {
    const iso = String(feat.id);   // topo id 是 string
    const info = isoToRegionInfo.get(iso);
    const fill = info ? info.color : '#E5E7EB';
    const d = path(feat);
    if (!d) return '';
    const title = info
      ? `${info.region} · p50 ${info.p50 != null ? info.p50 + 'ms' : '—'} · OK ${(info.okRate * 100).toFixed(0)}%`
      : (feat.properties?.name || iso);
    const dataAttrs = info
      ? ` data-region="${escapeHtml(info.region)}" data-p50="${info.p50 != null ? info.p50 : ''}" data-ok-rate="${info.okRate.toFixed(3)}"`
      : '';
    const cls = info ? 'country has-data' : 'country';
    return `<path id="c-${iso}" class="${cls}" d="${d}" style="--country-fill:${fill}" data-iso="${iso}"${dataAttrs}><title>${escapeHtml(title)}</title></path>`;
  }).join('');

  svg.innerHTML = paths;

  // 7. 鼠标 hover tooltip
  if (tip && !tip.dataset.wired) {
    tip.dataset.wired = '1';
    const wrap = svg.parentElement;  // .map-wrap
    wrap.addEventListener('mousemove', (e) => {
      const target = e.target.closest('.country.has-data');
      if (!target) {
        tip.classList.remove('visible');
        return;
      }
      const region = target.dataset.region;
      const p50 = target.dataset.p50;
      const okRate = parseFloat(target.dataset.okRate);
      tip.textContent = `${region} · p50 ${p50 !== '' ? p50 + 'ms' : '—'} · OK ${(okRate * 100).toFixed(0)}%`;
      const rect = wrap.getBoundingClientRect();
      tip.style.left = (e.clientX - rect.left) + 'px';
      tip.style.top = (e.clientY - rect.top) + 'px';
      tip.classList.add('visible');
    });
    wrap.addEventListener('mouseleave', () => {
      tip.classList.remove('visible');
    });
  }
}

// ---------- Billing receipt ----------
function wireBilling() {
  const form = document.getElementById('bill-form');
  const unlimited = document.getElementById('bill-unlimited');
  document.getElementById('bill-add').addEventListener('click', () => openBillForm());
  document.getElementById('bill-cancel').addEventListener('click', closeBillForm);
  document.getElementById('bill-source').addEventListener('change', (e) => {
    const source = billSources.find((s) => s.key === e.target.value);
    // 选了一个真实订阅源 → 自动切到 "续费"(用户仍然可以手动切回 "新增")
    if (source) {
      document.getElementById('bill-name').value = source.name;
      document.getElementById('bill-type').value = 'renewal';
    }
  });
  unlimited.addEventListener('change', syncUnlimitedField);
  form.addEventListener('submit', submitBill);
  document.getElementById('bill-list').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-bill-action]');
    if (!button) return;
    const bill = bills.find((item) => item.id === Number(button.dataset.billId));
    if (!bill) return;
    if (button.dataset.billAction === 'renew') openBillForm(bill);
    if (button.dataset.billAction === 'share') shareBill(bill);
    if (button.dataset.billAction === 'delete') deleteBill(bill);
  });
  // 支付人多选下拉 — checkbox 变更同步
  document.getElementById('bill-filter-payers').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-payer]');
    if (!cb) return;
    const payer = cb.dataset.payer;
    const idx = currentFilter.payers.indexOf(payer);
    if (cb.checked && idx < 0) currentFilter.payers.push(payer);
    else if (!cb.checked && idx >= 0) currentFilter.payers.splice(idx, 1);
    updatePayerDropdownLabel();
    applyClientFilter();
  });

  // 筛选面板 — 共享视图里整块隐藏,这里不用绑
  if (isSharedView) return;
  document.getElementById('bill-filter-from').addEventListener('change', (e) => {
    currentFilter.paidFrom = e.target.value;
    applyClientFilter();
  });
  document.getElementById('bill-filter-to').addEventListener('change', (e) => {
    currentFilter.paidTo = e.target.value;
    applyClientFilter();
  });
  document.getElementById('bill-filter-reset').addEventListener('click', () => {
    currentFilter = { paidFrom: '', paidTo: '', payers: [] };
    document.getElementById('bill-filter-from').value = '';
    document.getElementById('bill-filter-to').value = '';
    document.getElementById('bill-filter-payers').querySelectorAll('input[type="checkbox"]')
      .forEach((cb) => { cb.checked = false; });
    updatePayerDropdownLabel();
    applyClientFilter();
  });
  document.getElementById('bill-filter-share').addEventListener('click', createFilterShareLink);
}

// 从 bills 历史聚合去重支付人(下拉候选)
function refreshPayerOptions() {
  const list = document.getElementById('bill-payer-options');
  if (!list) return;
  const seen = new Set();
  bills.forEach((b) => { if (b.payer) seen.add(b.payer.trim()); });
  // 也把最近一次填过的支付人补进来(已保存的也覆盖)
  const last = localStorage.getItem('tw_bill_payer');
  if (last) seen.add(last.trim());
  knownPayers = Array.from(seen).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  list.innerHTML = knownPayers.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('');
}

function refreshPayerChips() {
  const root = document.getElementById('bill-filter-payers');
  if (!root) return;
  if (!knownPayers.length) {
    root.innerHTML = '<div class="payer-empty">还没有支付人记录</div>';
    updatePayerDropdownLabel();
    return;
  }
  root.innerHTML = knownPayers.map((p) => {
    const checked = currentFilter.payers.includes(p);
    return `<label class="payer-option"><input type="checkbox" data-payer="${escapeHtml(p)}"${checked ? ' checked' : ''}>${escapeHtml(p)}</label>`;
  }).join('');
  updatePayerDropdownLabel();
}

function updatePayerDropdownLabel() {
  const label = document.getElementById('payer-dropdown-label');
  if (!label) return;
  const n = currentFilter.payers.length;
  label.textContent = n === 0 ? '支付人 · 全部' : `支付人 · 已选 ${n}`;
}

function applyClientFilter() {
  renderBills();
}

function localISODate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function openBillForm(previous = null) {
  const today = localISODate();
  const nextYear = new Date(`${today}T12:00:00`);
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  document.getElementById('bill-form-heading').textContent = previous ? `续费 · ${previous.subscriptionName}` : '新增票据';
  document.getElementById('bill-source').value = previous?.subscriptionKey || '';
  document.getElementById('bill-name').value = previous?.subscriptionName || '';
  document.getElementById('bill-type').value = previous ? 'renewal' : 'purchase';
  document.getElementById('bill-amount').value = '';
  document.getElementById('bill-payer').value = previous?.payer || localStorage.getItem('tw_bill_payer') || '';
  document.getElementById('bill-paid-on').value = today;
  document.getElementById('bill-starts-on').value = previous?.expiresOn || today;
  document.getElementById('bill-expires-on').value = localISODate(nextYear);
  document.getElementById('bill-unlimited').checked = previous?.unlimited || false;
  document.getElementById('bill-note').value = '';
  document.getElementById('bill-form-status').textContent = '';
  document.getElementById('bill-form').hidden = false;
  syncUnlimitedField();
  document.getElementById('bill-amount').focus();
}

function closeBillForm() {
  document.getElementById('bill-form').hidden = true;
}

function syncUnlimitedField() {
  const checked = document.getElementById('bill-unlimited').checked;
  const expires = document.getElementById('bill-expires-on');
  document.getElementById('bill-expires-wrap').hidden = checked;
  expires.required = !checked;
  expires.disabled = checked;
}

async function loadBillSources() {
  if (!currentDevice) return;
  try {
    const res = await fetch(`/api/latest?device=${encodeURIComponent(currentDevice)}&kind=full`);
    if (!res.ok) return;
    const data = await res.json();
    billSources = (data.payload?.subscriptions || []).map((s) => ({
      key: s.url || '',
      name: s.flag || s.traffic?.sourceLabel || safeHost(s.url) || '订阅源',
    })).filter((s, i, all) => s.key && all.findIndex((x) => x.key === s.key) === i);
    const select = document.getElementById('bill-source');
    const selected = select.value;
    select.innerHTML = '<option value="">手动填写</option>' + billSources.map((s) =>
      `<option value="${escapeHtml(s.key)}">${escapeHtml(s.name)} · ${escapeHtml(safeHost(s.key))}</option>`
    ).join('');
    select.value = billSources.some((s) => s.key === selected) ? selected : '';
  } catch (e) {
    console.warn('load bill sources failed', e);
  }
}

async function loadBills() {
  if (!currentDevice) return;
  try {
    const res = await fetch('/api/bills', { headers: { 'X-Device-Uuid': currentDevice } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    bills = (await res.json()).bills || [];
    refreshPayerOptions();
    refreshPayerChips();
    applyClientFilter();
  } catch (e) {
    document.getElementById('bill-list').innerHTML = `<p class="receipt-empty">账本读取失败<br>${escapeHtml(e.message)}</p>`;
  }
}

async function loadSharedFilter(token) {
  try {
    const res = await fetch(`/api/bills/share-filter/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('分享筛选不存在或已失效');
    const data = await res.json();
    bills = data.bills || [];
    // 共享视图:只展示账本,隐藏主面板 / view-switcher / device-picker / footer
    document.body.classList.add('is-share-mode');
    showSharedBanner(data.filters);
    document.getElementById('bill-filter').hidden = true;
    document.getElementById('bill-add').hidden = true;
    document.querySelector('.receipt-kicker').textContent = 'SHARED RECEIPT';
    renderBills(true);
  } catch (e) {
    document.getElementById('bill-list').innerHTML = `<p class="receipt-empty">${escapeHtml(e.message)}</p>`;
  }
}

function showSharedBanner(filters) {
  const banner = document.getElementById('shared-banner');
  const desc = document.getElementById('shared-banner-desc');
  const parts = [];
  if (filters.paidFrom || filters.paidTo) {
    parts.push(`${filters.paidFrom || '不限'} → ${filters.paidTo || '不限'}`);
  }
  if (filters.payers && filters.payers.length) {
    parts.push(`支付人: ${filters.payers.join(' / ')}`);
  }
  desc.textContent = parts.length ? parts.join(' · ') : '全部票据';
  banner.hidden = false;
}

async function createFilterShareLink() {
  if (!currentDevice) return;
  const filters = {
    paidFrom: currentFilter.paidFrom || null,
    paidTo: currentFilter.paidTo || null,
    payers: currentFilter.payers.slice(),
  };
  try {
    const res = await fetch('/api/bills/share-filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Uuid': currentDevice },
      body: JSON.stringify(filters),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const url = data.shareUrl;
    // 只发纯 URL(用户要求);Web Share API 不带 text,降级到剪贴板也只放 URL
    try {
      if (navigator.share) {
        await navigator.share({ url });
      } else {
        await navigator.clipboard.writeText(url);
        setFooter('分享链接已复制', true);
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
  } catch (e) {
    setFooter('创建分享失败: ' + e.message, false);
  }
}

async function loadSharedBill(token) {
  try {
    const res = await fetch(`/api/bills/share/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('分享票据不存在或已失效');
    bills = [(await res.json()).bill];
    renderBills(true);
    document.getElementById('bill-add').hidden = true;
    document.querySelector('.receipt-kicker').textContent = 'SHARED RECEIPT';
  } catch (e) {
    document.getElementById('bill-list').innerHTML = `<p class="receipt-empty">${escapeHtml(e.message)}</p>`;
  }
}

async function submitBill(event) {
  event.preventDefault();
  if (!currentDevice) return;
  const status = document.getElementById('bill-form-status');
  const submit = event.submitter;
  submit.disabled = true;
  status.textContent = '打印中…';
  const amount = Number(document.getElementById('bill-amount').value);
  const payload = {
    subscriptionKey: document.getElementById('bill-source').value,
    subscriptionName: document.getElementById('bill-name').value,
    entryType: document.getElementById('bill-type').value,
    amountFen: Math.round(amount * 100),
    payer: document.getElementById('bill-payer').value,
    paidOn: document.getElementById('bill-paid-on').value,
    startsOn: document.getElementById('bill-starts-on').value,
    expiresOn: document.getElementById('bill-expires-on').value || null,
    unlimited: document.getElementById('bill-unlimited').checked,
    note: document.getElementById('bill-note').value,
  };
  try {
    const res = await fetch('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Uuid': currentDevice },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    localStorage.setItem('tw_bill_payer', payload.payer.trim());
    bills.unshift(data.bill);
    refreshPayerOptions();
    refreshPayerChips();
    closeBillForm();
    applyClientFilter();
    document.getElementById('receipt-paper').scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    status.textContent = e.message;
  } finally {
    submit.disabled = false;
  }
}

function filterBillsForView(all) {
  // 共享模式(后端已经按 filter 筛过)直接全收;否则按 currentFilter 本地再筛一次
  if (isSharedView || sharedBillToken) return all;
  return all.filter((b) => {
    if (currentFilter.paidFrom && b.paidOn < currentFilter.paidFrom) return false;
    if (currentFilter.paidTo && b.paidOn > currentFilter.paidTo) return false;
    if (currentFilter.payers.length && !currentFilter.payers.includes(b.payer)) return false;
    return true;
  });
}

function renderBills(shared = false) {
  const list = document.getElementById('bill-list');
  const view = filterBillsForView(bills);
  const totalFen = view.reduce((sum, bill) => sum + bill.amountFen, 0);
  document.getElementById('receipt-count').textContent = `NO. ${String(view.length).padStart(3, '0')}`;
  document.getElementById('receipt-total').textContent = formatRmb(totalFen);
  document.getElementById('receipt-summary-label').textContent =
    isSharedView || sharedBillToken || hasActiveFilter() ? '当前视图合计' : '累计支出';
  if (!view.length) {
    list.innerHTML = '<p class="receipt-empty">没有匹配的票据<br>调整筛选条件或记一笔</p>';
    return;
  }
  list.innerHTML = view.map((bill, index) => `
    <article class="receipt-entry" style="animation-delay:${Math.min(index * 30, 180)}ms">
      <div class="receipt-entry-head"><strong>${escapeHtml(bill.subscriptionName)}</strong><span>#${String(bill.id).padStart(5, '0')}</span></div>
      <div class="receipt-kind">${bill.entryType === 'renewal' ? 'RENEWAL / 续费' : 'NEW / 新增'}</div>
      <div class="receipt-line receipt-paid-on"><span>支付时间</span><b>${escapeHtml(bill.paidOn)}</b></div>
      <div class="receipt-line"><span>支付人</span><b>${escapeHtml(bill.payer)}</b></div>
      <div class="receipt-line"><span>周期</span><b>${bill.unlimited ? '不限时间' : `${escapeHtml(bill.startsOn)} → ${escapeHtml(bill.expiresOn)}`}</b></div>
      ${bill.note ? `<div class="receipt-line"><span>备注</span><b>${escapeHtml(bill.note)}</b></div>` : ''}
      <div class="receipt-line receipt-amount"><span>合计</span><b>${formatRmb(bill.amountFen)}</b></div>
      ${shared ? '' : `<div class="receipt-actions">
        <button data-bill-action="renew" data-bill-id="${bill.id}">再续一节</button>
        <button data-bill-action="share" data-bill-id="${bill.id}">分享</button>
        <button data-bill-action="delete" data-bill-id="${bill.id}">删除</button>
      </div>`}
    </article>`).join('');
}

function hasActiveFilter() {
  return !!(currentFilter.paidFrom || currentFilter.paidTo || currentFilter.payers.length);
}

async function shareBill(bill) {
  const text = `${bill.subscriptionName} · ${bill.entryType === 'renewal' ? '续费' : '新增'} · ${formatRmb(bill.amountFen)} · ${bill.paidOn}`;
  try {
    if (navigator.share) await navigator.share({ title: 'TunnelWatch 账单', text, url: bill.shareUrl });
    else {
      await navigator.clipboard.writeText(`${text}\n${bill.shareUrl}`);
      setFooter('分享链接已复制', true);
    }
  } catch (e) {
    if (e.name !== 'AbortError') setFooter('分享失败: ' + e.message, false);
  }
}

async function deleteBill(bill) {
  if (!confirm(`删除 ${bill.subscriptionName} 的这张票据？`)) return;
  const res = await fetch(`/api/bills/${bill.id}`, { method: 'DELETE', headers: { 'X-Device-Uuid': currentDevice } });
  if (!res.ok) {
    setFooter('删除失败', false);
    return;
  }
  bills = bills.filter((item) => item.id !== bill.id);
  refreshPayerOptions();
  refreshPayerChips();
  applyClientFilter();
}

function formatRmb(fen) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format((fen || 0) / 100);
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ---------- Chart helpers ----------
function chartUpdate(canvasId, key, config) {
  const ctx = document.getElementById(canvasId);
  if (charts[key]) {
    charts[key].data = config.data;
    charts[key].options = config.options;
    charts[key].update();
  } else {
    charts[key] = new Chart(ctx, config);
  }
}

function chartOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      // 6x6 实心方块图例 — line chart 在 boxWidth=boxHeight 时会撑成"口"形小方框,
      // 用 6x6 既保持"小色块"风格又明确显示 dataset 颜色(line + bar 都一致)
      legend: { display: true, position: 'bottom', labels: { boxWidth: 6, boxHeight: 6, font: { size: 12 }, color: COLORS.axis, padding: 10, usePointStyle: false } },
      tooltip: { backgroundColor: '#1A1F2E', padding: 10, cornerRadius: 6, titleFont: { size: 13 }, bodyFont: { size: 12 } }
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 11 }, color: COLORS.axis, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
      y: { grid: { color: COLORS.gridLine }, ticks: { font: { size: 11 }, color: COLORS.axis, padding: 4 }, ...(extra.y || {}) }
    },
    elements: { line: { borderWidth: 1.8 }, point: { radius: 2.5, hoverRadius: 5 } }
  };
}

// ---------- Data helpers ----------
function perUidLineStats(lines, probeLines) {
  // 用 probe 数据(更新);没有就退化到 lines
  const stats = {};
  (probeLines || lines).forEach(l => {
    const uid = (l.uidTag || '').split(',')[0].trim();
    if (!uid) return;
    if (!stats[uid]) stats[uid] = { ok: 0, total: 0 };
    stats[uid].total++;
    if (l.probe?.status === 'OK') stats[uid].ok++;
  });
  return stats;
}

function bucketKey(ts, minutes) {
  return Math.floor(ts / (minutes * 60 * 1000)) * (minutes * 60 * 1000);
}

function formatTime(ts, hours = 24) {
  const d = new Date(ts);
  // 7d / 30d 视角下用 MM-dd 更清晰,避免 HH:mm 在 4-7 天里挤成一团
  if (hours >= 168) {
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
  }
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0');
}

function renderStatusDot(online) {
  const color = online ? COLORS.ok : COLORS.err;
  return `<span class="mirror-status-dot" style="background:${color}"></span>`;
}

function intToHex(c) {
  return '#' + (c & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, ch => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'
  })[ch]);
}

function setFooter(text, ok) {
  const el = document.getElementById('footer-status');
  el.innerHTML = `<span class="pulse" style="background:${ok ? COLORS.ok : COLORS.err}"></span>${escapeHtml(text)}`;
}
