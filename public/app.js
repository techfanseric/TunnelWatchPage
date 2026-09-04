// TunnelWatch 状态面板 — 前端逻辑
// - 拉 /api/devices 填充下拉
// - 拉 /api/latest 渲染卡片镜像
// - 拉 /api/history 渲染 4 张图
// - 最新状态 2 分钟刷新,历史趋势 15 分钟刷新

import { feature } from 'topojson-client';
import { geoNaturalEarth1, geoPath } from 'd3-geo';

const LATEST_REFRESH_MS = 2 * 60_000;
const HISTORY_REFRESH_MS = 15 * 60_000;
// 发版标签 — 每次 `wrangler pages deploy` 前手动 bump 一下,刷新页面看 header 是否更新 → 确认 deploy 生效
// 格式:YYYY.MM.DD-HHMM(本地时间),不需要严格 semver,关键是要"每次发版都换字符串"
const APP_VERSION = '2026.09.05-0004';
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

// 延迟刻度配色:<50ms 绿 / <150ms 黄 / ≥150ms 红(与世界地图 colorByP50 同一刻度)
function latencyColor(ms) {
  if (ms == null || !Number.isFinite(ms)) return COLORS.secondary;
  if (ms < 50) return COLORS.ok;
  if (ms < 150) return COLORS.warn;
  return COLORS.err;
}

// ---------- 状态 ----------
let currentDevice = null;     // uuid
let currentHours = 24;        // 时间窗:24 / 168 / 720(24h / 7d / 30d)
let currentRegionSort = 'count';    // 按地区 排序:'count' 充裕在前(节点数降序) / 'latency' ⚡延迟快(p50 升序)
let currentRenewalSort = 'expiry';  // 续费建议榜 排序:'expiry' 快到期(到期天数升序) / 'score' 推荐高(综合分降序)
// 设备列表本地缓存(loadDevices 拉一次后存这里,弹层 / 角标 / footer 都要查)
let devices = [];
// 静默时段默认值(分钟数 0..1439)— spec §2
const QUIET_DEFAULT_START = 0;    // 00:00
const QUIET_DEFAULT_END = 480;    // 08:00
// 订阅源连通性 / 失败节点数 两张图固定为"时间趋势"折线图:
//   连通性  — x=时间,每订阅源一条线(每 sub 的失败节点数随时间变化)
//   失败节点 — x=时间,各地区一条线(各 region 失败节点数随时间变化)
// 不再提供"最新快照"切到堆叠柱状图的选项:节点健康度直接看 chart-sub-ok-rate 更准,
// 一张快照看不出"变化"也暴露不了真实问题。
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
  MY: '458', TH: '764', VN: '704', TR: '792', CA: '124',
  FR: '250', ID: '360',
  CN: '156',
};
// 缓存最近一次 history fetch(7d/30d 地图复用)
let lastHistoryItems = null;
let lastHistoryHours = null;
// 缓存 world-atlas GeoJSON(50m,模块加载完就解析一次)
let worldGeoFeatures = null;
// ---------- ETag + 304 + in-flight dedup(轮询不重渲的核心) ----------
// 同一个 URL 在同一轮刷新里有多个 render 函数并发打,用 inFlight 复用同一个 Promise
// 命中 304 时直接返回上一次的对象引用,render 函数通过 === 对比决定要不要重渲 DOM/Chart
const inflight = new Map();   // url -> Promise<{ data, etag }>
const dataCache = new Map();  // url -> { data, etag }
// 上一轮各 render 函数看到的 data 引用(用于对象身份对比:=== 即"无变化")
const lastDataRef = {
  mirrorFull: null,
  mirrorProbe: null,
  renewal: null,
  region: null,
  protocol: null,
  history: null,
};
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

// 带 ETag 的 fetch + in-flight 复用 + 304 命中返回旧引用
// 行为契约:
//   - 首次请求:正常发,200 后缓存 {data, etag}
//   - 后续请求:带 If-None-Match,服务端 304 时**直接返回上一次的 data 引用**(引用相同 → render 函数用 === 即可识别"无变化")
//   - 同 URL 并发:inFlight 复用同一个 Promise,避免一轮 refreshAll 内对 /api/latest?kind=full 打 3 次
//   - 非 200(404/500 等):抛错,不污染缓存
async function fetchJSON(url) {
  if (inflight.has(url)) return inflight.get(url);
  const cached = dataCache.get(url);
  const headers = cached ? { 'If-None-Match': cached.etag } : {};
  const p = (async () => {
    const res = await fetch(url, { headers });
    if (res.status === 304) {
      // 服务端确认未变 → 返回旧引用(关键:引用相同 → render 函数可以 === 判断)
      if (cached) return cached;
      // 边界:第一次就 304(不会发生,服务端只在有缓存时 304),保护性抛错
      throw new Error('304 without prior cache');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      noteQuotaFailure(error);
      throw new Error(error.message || 'HTTP ' + res.status);
    }
    const data = await res.json();
    const entry = { data, etag: res.headers.get('ETag') };
    dataCache.set(url, entry);
    return entry;
  })();
  inflight.set(url, p);
  p.then(() => inflight.delete(url), () => inflight.delete(url));
  return p;
}

// 设备切换 / 视角切换时清缓存(URL 变了,旧 ETag 没意义)
function clearDataCache() {
  dataCache.clear();
  inflight.clear();
  lastDataRef.mirrorFull = null;
  lastDataRef.mirrorProbe = null;
  lastDataRef.renewal = null;
  lastDataRef.region = null;
  lastDataRef.protocol = null;
  lastDataRef.history = null;
  // 保留 lastHistoryItems/worldGeoFeatures 这两个非 ETag 缓存(地图和 TopoJSON 还可用)
}

let latestRefreshTimer = null;
let historyRefreshTimer = null;
function startRefreshTimers() {
  if (!latestRefreshTimer) latestRefreshTimer = setInterval(refreshLatest, LATEST_REFRESH_MS);
  if (!historyRefreshTimer) historyRefreshTimer = setInterval(refreshHistory, HISTORY_REFRESH_MS);
}
function stopRefreshTimers() {
  if (latestRefreshTimer) clearInterval(latestRefreshTimer);
  if (historyRefreshTimer) clearInterval(historyRefreshTimer);
  latestRefreshTimer = null;
  historyRefreshTimer = null;
}

// D1 配额 widget — /api/usage,5min 一刷。edge cache 5min,实际打到 GraphQL
// 频率取决于网络边缘节点数 × 用户数,正常情况一天 < 200 次,远低于 CF GraphQL 限速
const USAGE_REFRESH_MS = 5 * 60_000;
let usageRefreshTimer = null;
let latestUsage = null;
let quotaFailureAt = 0;

function noteQuotaFailure(data) {
  if (data?.error === 'D1_DAILY_READ_LIMIT') {
    quotaFailureAt = Date.now();
    renderQuotaNotice();
  }
}

function renderQuotaNotice() {
  const notice = document.getElementById('quota-notice');
  const detail = document.getElementById('quota-notice-detail');
  if (!notice || !detail) return;
  const now = Date.now();
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const freshUsage = latestUsage && new Date(latestUsage.windowEnd).getTime() > now;
  const exhausted = freshUsage && Number(latestUsage.limit) > 0 && Number(latestUsage.rowsRead) >= Number(latestUsage.limit);
  notice.hidden = !exhausted && quotaFailureAt < dayStart;
  if (notice.hidden) return;
  const counts = freshUsage
    ? `账号已读 ${Number(latestUsage.rowsRead).toLocaleString('zh-CN')} / ${Number(latestUsage.limit).toLocaleString('zh-CN')} 行，TunnelWatch 本库 ${Number(latestUsage.databaseRowsRead || 0).toLocaleString('zh-CN')} 行。`
    : '云端已确认今日读取额度耗尽。';
  const reset = new Date(dayStart + 86_400_000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  detail.textContent = `${counts} 下次重置：${reset}（北京时间；UTC 00:00）。额度由账号内所有 D1 数据库共享，统计可能延迟。`;
}

function startUsageTimer() {
  loadUsage();
  if (usageRefreshTimer) return;
  usageRefreshTimer = setInterval(loadUsage, USAGE_REFRESH_MS);
}
function stopUsageTimer() {
  if (usageRefreshTimer) { clearInterval(usageRefreshTimer); usageRefreshTimer = null; }
}

async function loadUsage() {
  const meter = document.getElementById('usage-meter');
  const text  = document.getElementById('usage-text');
  const fill  = document.getElementById('usage-bar-fill');
  if (!meter || !text || !fill) return;
  try {
    const res = await fetch('/api/usage');
    const data = await res.json().catch(() => ({}));
    if (res.status === 503 && data && data.code === 'missing_token') {
      // 最常见:用户没配 token — 静默提示,不报错打扰
      text.textContent = 'D1 用量 · 未配置 token';
      text.title = data.help || data.error || '';
      meter.classList.remove('warn', 'danger');
      meter.classList.add('error');
      fill.style.width = '0%';
      meter.hidden = false;
      return;
    }
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }
    const rowsRead = Number(data.rowsRead) || 0;
    latestUsage = data;
    renderQuotaNotice();
    const limit    = Number(data.limit) || 0;
    const pct      = Math.max(0, Math.min(100, Number(data.pct) || 0));
    const resetsAt = data.resetsAt ? new Date(data.resetsAt) : null;
    text.textContent = `账号 ${formatBig(rowsRead)} / ${formatBig(limit)} · ${pct.toFixed(1)}% · 余 ${formatBig(Math.max(0, limit - rowsRead))}`;
    text.title = [
      `今日账号全部 D1 rowsRead: ${rowsRead.toLocaleString()} / ${limit.toLocaleString()}`,
      `TunnelWatch 本库 rowsRead: ${Number(data.databaseRowsRead || 0).toLocaleString()}`,
      `rowsWritten: ${(data.rowsWritten || 0).toLocaleString()}`,
      'Cloudflare 分析数据可能延迟，页面每 5 分钟刷新；余量不保证实时。',
      resetsAt ? `重置: ${resetsAt.toISOString().replace('T', ' ').slice(0, 16)} UTC` : '',
    ].filter(Boolean).join('\n');
    fill.style.width = pct + '%';
    meter.classList.remove('error');
    if (pct >= 80) { meter.classList.remove('warn'); meter.classList.add('danger'); }
    else if (pct >= 50) { meter.classList.remove('danger'); meter.classList.add('warn'); }
    else { meter.classList.remove('warn', 'danger'); }
    meter.hidden = false;
  } catch (e) {
    text.textContent = 'D1 用量 · 拉取失败';
    text.title = e && e.message ? e.message : String(e);
    meter.classList.remove('warn', 'danger');
    meter.classList.add('error');
    meter.hidden = false;
  }
}

function formatBig(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

// 后台标签页暂停轮询(visibility 隐藏时浏览器本身会节流 setInterval,但显式停掉更可控)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopRefreshTimers();
    stopUsageTimer();
  } else {
    // 回到前台只拉轻量最新状态;历史数据继续服从 15 分钟周期。
    refreshLatest();
    startRefreshTimers();
    startUsageTimer();
  }
});

async function init() {
  wireBilling();
  wireViewSwitcher();
  wireRegionSortSwitcher();
  wireRenewalSortSwitcher();
  wireQuietHours();
  syncViewSwitcherActive();   // URL 参数 / default 同步到按钮高亮
  updateChartTitles();   // 初始化时就把 {H} 占位符替换掉(默认 24h)
  updateBucketHint(HOURS_BUCKET_MIN[currentHours] || 15);
  // 把发版标签塞进 header 右侧(确认 deploy 生效用)
  const v = document.getElementById('brand-version');
  if (v) v.textContent = 'Version. ' + APP_VERSION;
  await loadDevices();
  startRefreshTimers();
  startUsageTimer();
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
    // hours 变了 → history URL 变了,清掉旧 hours 的 lastDataRef(让新 hours 强制走 200 拉一次)
    lastDataRef.history = null;
    refreshHistory();
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
    // 切排序不需要重拉数据;force=true 跳过 === 早退,保证 304 命中时也能重渲 DOM
    renderRegionCard({ force: true });
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
    // 切排序不需要重拉数据;force=true 跳过 === 早退,保证 304 命中时也能重渲 DOM
    renderRenewalCard({ force: true });
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
    const data = await res.json().catch(() => ({}));
    noteQuotaFailure(data);
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    devices = (data && data.devices) || [];
    const sel = document.getElementById('device-select');
    sel.innerHTML = '';
    if (devices.length === 0) {
      sel.innerHTML = '<option value="">未授权设备</option>';
      setFooter('未授权设备 — wrangler d1 execute 注册 UUID', false);
      recomputeQuietBadge();
      recomputeQuietStatus();
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
      // 设备切换 → 旧设备的 ETag/引用全作废,必须清,否则会拿旧设备的数据去对比新设备
      clearDataCache();
      refreshAll();
      if (!sharedBillToken && !isSharedView) loadBills();
      loadBillSources();
      // 静默时段相关的 UI 也得跟着设备切:角标、footer 状态、弹层(若开着)
      onCurrentDeviceChanged();
    });
    // 默认选上次记忆的,否则第一个
    const remembered = localStorage.getItem('tw_device');
    const target = devices.find(d => d.uuid === remembered) || devices[0];
    sel.value = target.uuid;
    currentDevice = target.uuid;
    // 初次进入也要刷一下静默时段相关的 UI
    recomputeQuietBadge();
    recomputeQuietStatus();
    startQuietHoursTimer();
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
    document.getElementById('device-select').innerHTML = '<option value="">暂时无法加载设备</option>';
    document.getElementById('bill-list').innerHTML = `<p class="receipt-empty">暂时无法加载账本<br>${escapeHtml(e.message)}</p>`;
  }
}

async function refreshAll() {
  if (!currentDevice) return;
  const groups = await Promise.all([
    refreshLatest({ updateFooter: false }),
    refreshHistory({ updateFooter: false }),
  ]);
  updateRefreshFooter(groups.flat());
}

async function refreshLatest({ updateFooter = true } = {}) {
  if (!currentDevice) return [];
  const results = await Promise.all([renderMirror(), renderRegionCard(), renderProtocolChart()]);
  // 24h 地图取 latest;长时间窗地图由 refreshHistory 使用已有 history 数据。
  if (currentHours === 24) renderWorldMapCard();
  if (updateFooter) updateRefreshFooter(results);
  return results;
}

async function refreshHistory({ updateFooter = true } = {}) {
  if (!currentDevice) return [];
  const results = await Promise.all([renderRenewalCard(), renderCharts(currentHours)]);
  renderWorldMapCard();
  if (updateFooter) updateRefreshFooter(results);
  return results;
}

function updateRefreshFooter(results) {
  if (quotaFailureAt >= Math.floor(Date.now() / 86_400_000) * 86_400_000) {
    setFooter('云端读取受限 · 今日账号 D1 配额已满，见顶部说明', false);
    return;
  }
  // results: 每个 render 返回 true=已更新 / false=无变化/失败
  // "无变化"指服务端 304 命中(数据未变)→ render 函数早早 return false,DOM/Chart 不动
  const changed = results.filter(Boolean).length;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  setFooter(
    changed === 0
      ? `无变化 · ${ts}`
      : `已更新 ${changed} 项 · ${ts}`,
    true
  );
}

// ---------- 卡片镜像 ----------
async function renderMirror() {
  try {
    // 用 fetchJSON(ETag + 304 + in-flight dedup)— full 失败抛错,probe 失败视作"无 probe"
    const [fullEntry, probeEntry] = await Promise.all([
      fetchJSON(`/api/latest?device=${currentDevice}&kind=full`).catch(e => ({ error: e })),
      fetchJSON(`/api/latest?device=${currentDevice}&kind=probe`).catch(e => ({ error: e })),
    ]);
    if (fullEntry.error) {
      const msg = fullEntry.error.message.includes('404') ? '该设备暂无 FULL 快照' : '加载失败: ' + fullEntry.error.message;
      setMirrorEmpty(msg);
      return false;
    }
    const data = fullEntry.data;
    const probeData = probeEntry.error ? null : probeEntry.data;
    const probeTs = probeData?.ts;
    // 引用相同 → 数据未变,跳过整个 DOM 重写(保留选中/焦点/滚动,避免 Chart.js 触发无意义重绘)
    if (data === lastDataRef.mirrorFull && probeData === lastDataRef.mirrorProbe) {
      return false;
    }
    lastDataRef.mirrorFull = data;
    lastDataRef.mirrorProbe = probeData;
    const s = data.summary || {};
    const p = data.payload || {};

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
    // 注意:subLoadSummary("12/12 订阅源 OK")已在上方 mirror-sub-row 展示,这里不再重复
    meta.innerHTML = parts.length ? parts.join(' · ') : '<span class="empty">—</span>';
    return true;
  } catch (e) {
    setMirrorEmpty('加载失败: ' + e.message);
    return false;
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
async function renderRegionCard({ force = false } = {}) {
  try {
    let data;
    try {
      ({ data } = await fetchJSON(`/api/latest?device=${currentDevice}&kind=full`));
    } catch (e) {
      const empty = e.message.includes('404') ? '— 暂无数据 —' : '<span class="empty">加载失败: ' + e.message + '</span>';
      document.getElementById('region-list').innerHTML = empty;
      return false;
    }
    if (!force && data === lastDataRef.region) {
      return false;  // 数据未变 + 不强制 → 跳过整个 region-list innerHTML 重建(保留用户选中的 region row)
    }
    lastDataRef.region = data;
    const s = data.summary || {};
    const rs = s.regionStats || {};
    // total=0 的 region 跳过(等于"测了 0 个节点"=没这个地区)
    const entries = Object.entries(rs).filter(([_, v]) => v.total > 0);
    if (entries.length === 0) {
      document.getElementById('region-list').innerHTML = '<span class="empty">— 该设备未上传地区数据 —</span>';
      return false;
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
      // 单点:fastest/slowest 指向同一个节点(只有 1 个 OK 节点),不区分 ⚡/🐌,只显示一个数字
      const singlePoint = fast && slow && fast.latency === slow.latency && fast.name === slow.name;
      if (singlePoint) {
        fsBlock = `
          <div class="rr-fs-line">
            <span class="fs-fast" style="color:${latencyColor(fast.latency)}">${fast.latency}ms</span>
            <span class="fs-name" title="${escapeHtml(fast.name)}">${escapeHtml(fast.name)}</span>
          </div>`;
      } else if (fast && slow) {
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
        // 差距条保持渐变,但渐变的颜色停靠点锚定绝对延迟刻度(<50 绿 / <150 黄 / ≥150 红),
        // 而不是行内相对位置 — 否则 "5─12ms" 和 "4─760ms" 两行会渲染出同样的绿→红渐变,
        // 让人误以为 50ms 的标记比 10ms 的还快。阈值(50/150ms)附近留过渡带,视觉仍是渐变。
        const range = slow.latency - fast.latency;
        const toPct = (t) => Math.max(0, Math.min(100, ((t - fast.latency) / range) * 100));
        const wPct = Math.min(10, Math.max(2, (30 / range) * 100));  // 过渡带宽 ≈30ms
        const pA = toPct(50);
        const pB = toPct(150);
        const stops = [`${latencyColor(fast.latency)} 0%`];
        if (pA > 0 && pA < 100) {
          stops.push(`${COLORS.ok} ${Math.max(0, pA - wPct).toFixed(1)}%`);
          stops.push(`${COLORS.warn} ${Math.min(100, pA + wPct).toFixed(1)}%`);
        }
        if (pB > 0 && pB < 100) {
          stops.push(`${COLORS.warn} ${Math.max(0, pB - wPct).toFixed(1)}%`);
          stops.push(`${COLORS.err} ${Math.min(100, pB + wPct).toFixed(1)}%`);
        }
        stops.push(`${latencyColor(slow.latency)} 100%`);
        const barBg = `linear-gradient(to right, ${stops.join(', ')})`;
        // ⚡/🐌 数字按延迟刻度着色(<50 绿 / <150 黄 / ≥150 红),不再固定绿/红
        fsBlock = `
          <div class="rr-fs-line">
            <span class="fs-fast" style="color:${latencyColor(fast.latency)}">⚡ ${fast.latency}ms</span>
            <span class="fs-name" title="${escapeHtml(fast.name)}">${escapeHtml(fast.name)}</span>
            <span style="color:var(--secondary,#888);">·</span>
            <span class="fs-slow" style="color:${latencyColor(slow.latency)}">🐌 ${slow.latency}ms</span>
            <span class="fs-name" title="${escapeHtml(slow.name)}">${escapeHtml(slow.name)}</span>
            <span class="fs-ratio">▲ ${ratio}</span>
          </div>
          <div class="fs-bar-wrap">
            <span class="fs-bar" style="background:${barBg}" title="p50 ${p50Title} 落在 [${fast.latency}, ${slow.latency}] ms">
              ${v.p50 != null ? `<span class="marker" style="left:${markerPct.toFixed(0)}%"></span>` : ''}
            </span>
            <span class="fs-range">${fast.latency}─${slow.latency} ms</span>
          </div>`;
      } else {
        // 全失败(0 OK)→ 只显示 "—"
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
    return true;
  } catch (e) {
    document.getElementById('region-list').innerHTML = '<span class="empty">加载失败: ' + e.message + '</span>';
    return false;
  }
}

// ---------- 协议分布(pie) ----------
async function renderProtocolChart() {
  try {
    let data;
    try {
      ({ data } = await fetchJSON(`/api/latest?device=${currentDevice}&kind=full`));
    } catch (e) {
      // 协议分布是辅助视图,full 缺失时静默跳过
      return false;
    }
    if (data === lastDataRef.protocol) {
      return false;  // 协议分布无变化 → 不调用 chartUpdate(避免 Chart.js 重绘 canvas)
    }
    lastDataRef.protocol = data;
    const ps = data.summary?.protocolStats || {};
    const entries = Object.entries(ps);
    if (entries.length === 0) return false;
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
    return true;
  } catch (e) {
    console.error('renderProtocolChart failed:', e);
    return false;
  }
}

// ---------- 续费建议榜(PRIMARY) — 客户端按时间窗聚合算分 ----------
// 综合分公式(对齐 agent 端 computeSubscriptionScores @ TelemetryPublisher.kt):
//   可用率 40%   p50 / 价值 15% / 覆盖面 10% / 稳定性 10%
// 不同点:可用率 + 稳定性 改用 history items 时间窗聚合,而不是"当下"。
//   - 可用率 40%   ← time-window mean(subLineStats[sub].ok / total)
//   - 稳定性 10%   ← 1 - mean(okRate) 过去一段时间的失败率
//   - 性能 25% / 价值 15% / 覆盖面 10% 取最新 snapshot 的值(节点结构/网络近况,不适合跨窗聚合)
// sub 的元数据(sub / flag / expireAtMillis / daysToExpire / uniqueValue / nodeCount / regionCount / p50)
// 都从最新 snapshot 的 subscriptionScores 透传,保持显示一致。
function computeRenewalScoresFromHistory(items, rangeHours) {
  if (!items || items.length === 0) return [];
  // 1. 收集时间窗内每个 subUrl 的 okRate 序列 + 锁定"最新 FULL snapshot"作为元数据源
  const series = new Map();  // subUrl -> okRates: number[]
  let latestSummary = null;
  let latestTs = 0;
  for (const it of items) {
    if (it.kind !== 'full') continue;
    const s = it.summary || {};
    const subStats = s.subLineStats || {};
    if (Object.keys(subStats).length === 0) continue;
    if (it.ts > latestTs) {
      latestTs = it.ts;
      latestSummary = s;
    }
    for (const [url, st] of Object.entries(subStats)) {
      const total = st.total || 0;
      const ok = st.ok || 0;
      if (total <= 0) continue;
      if (!series.has(url)) series.set(url, []);
      series.get(url).push(ok / total);
    }
  }
  if (!latestSummary) return [];
  const latestScores = latestSummary.subscriptionScores || [];
  if (latestScores.length === 0) return [];
  const metaByUrl = new Map(latestScores.map(sc => [sc.subUrl, sc]));
  if (metaByUrl.size === 0) return [];
  // 2. 算每个 sub 的新 score
  const out = [];
  for (const [url, okRates] of series) {
    const meta = metaByUrl.get(url);
    if (!meta) continue;  // 最新 snapshot 已不含这个 sub,跳过
    // 时间窗聚合:可用率 / 稳定性
    const meanOkRate = okRates.reduce((a, b) => a + b, 0) / okRates.length;
    const meanFailRate = 1 - meanOkRate;
    // 节点结构取最新 snapshot(原 agent 公式语义:line probe 延迟、节点数、地区数)
    const p50 = meta.p50;
    const total = meta.nodeCount || 0;
    const regionCount = meta.regionCount || 0;
    // 可用率 40% — 历史
    const scoreAvailability = meanOkRate * 100;
    // 性能 25% — 跟 agent 公式一致:p50<100ms 100,>500ms 0,线性内插;无样本给 50
    const scorePerformance = (p50 == null) ? 50.0
      : p50 < 100 ? 100.0
      : p50 > 500 ? 0.0
      : 100.0 - ((p50 - 100) / 400) * 100;
    // 价值 15%
    const scoreValue = Math.min(total / 100, 1) * 100;
    // 覆盖面 10%
    const scoreCoverage = Math.min(regionCount / 8, 1) * 100;
    // 稳定性 10% — 历史
    const scoreStability = meanFailRate < 0.05 ? 100
      : meanFailRate > 0.30 ? 0
      : 100 - ((meanFailRate - 0.05) / 0.25) * 100;
    const raw = scoreAvailability * 0.40
      + scorePerformance * 0.25
      + scoreValue * 0.15
      + scoreCoverage * 0.10
      + scoreStability * 0.10;
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    const recommend = score >= 70 ? 'renew' : score >= 50 ? 'consider' : 'replace';
    out.push({
      sub: meta.sub,
      subUrl: url,
      score,
      recommend,
      okRate: meanOkRate,            // 覆盖 agent 的"当下值",显示用时间窗均值
      p50,
      nodeCount: total,
      regionCount,
      failRate24h: meanFailRate,     // 字段名保持兼容(原意为"过去一段时间的 fail 率",现在真的是了)
      expireAtMillis: meta.expireAtMillis,
      daysToExpire: meta.daysToExpire,
      uniqueValue: meta.uniqueValue || [],
      // 给 hint 文案用
      _buckets: okRates.length,
    });
  }
  return out;
}

async function renderRenewalCard({ force = false } = {}) {
  try {
    let items;
    try {
      // 改用 /api/history(hours=currentHours),score 跟时间窗走
      // 与 renderCharts 共享 fetchJSON 的 URL 缓存,同 URL 自动 dedup
      const entry = await fetchJSON(`/api/history?device=${currentDevice}&hours=${currentHours}`);
      items = entry.data.items;
    } catch (e) {
      const empty = e.message.includes('404') ? '— 暂无数据 —' : '<span class="empty">加载失败: ' + e.message + '</span>';
      document.getElementById('renewal-list').innerHTML = empty;
      return false;
    }
    if (!force && items === lastDataRef.renewal) {
      return false;  // 续费榜快照未变 + 不强制 → 跳过整张表的 innerHTML 重建
    }
    lastDataRef.renewal = items;
    const scores = computeRenewalScoresFromHistory(items, currentHours);
    if (scores.length === 0) {
      document.getElementById('renewal-list').innerHTML = '<span class="empty">— 该设备未上传续费数据 —</span>';
      return false;
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
      const label = HOURS_LABEL[currentHours] || '24h';
      hint.textContent = currentRenewalSort === 'score'
        ? `推荐高 · 综合分降序 · ${label} 聚合`
        : `快到期 · 到期天数升序 · ${label} 聚合`;
    }
    // 名称列宽自适应:按当前列表最长名字的显示宽度估算(CJK/emoji 记 2,其余记 1),
    // 所有行共用同一宽度 — 贴内容走(13px 字体下 1 单位 ≈ 6.5px),不留多余空白
    const nameUnits = (t) => {
      let w = 0;
      for (const ch of String(t ?? '')) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u2600-\u27BF\u{1F000}-\u{1FAFF}]/u.test(ch) ? 2 : 1;
      return w;
    };
    const nameColW = Math.max(32, Math.min(140,
      Math.round(Math.max(0, ...sortedScores.map(s => nameUnits(s.sub))) * 6.5) + 4));
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
      // 浅灰底通栏 + 居中,让"补 XX / YY"在视觉上成为一个整块提示条
      const uniqueLine = unique.length > 0
        ? `<div style="margin-top:6px;padding:4px 8px;font-size:11px;color:${COLORS.primary};line-height:1.4;background:#F3F4F6;border-radius:6px;text-align:center;">
             补 ${unique.map(escapeHtml).join(' / ')}
           </div>`
        : '';
      // uniqueLine 拉通显示在整行下方,不挤在右侧单元格里(避免把该列撑得很高)
      return `<div class="renewal-row" style="
        padding:10px 4px;border-bottom:1px solid var(--border);
      ">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="flex:0 0 ${nameColW}px;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(s.sub)}">${escapeHtml(s.sub)}</div>
          </div>
          <div style="flex:0 0 40px;text-align:center;">
            <!-- 分数本身已按建议等级着色,不再画进度条(信息重复) -->
            <div style="font-size:20px;font-weight:700;color:${renewColor[s.recommend] || COLORS.secondary};font-variant-numeric:tabular-nums;line-height:1;">${score}</div>
          </div>
          <div style="flex:0 0 56px;text-align:center;">
            <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#FFFFFF;background:${renewColor[s.recommend] || COLORS.secondary};">${renewBadge[s.recommend] || '?'}</span>
          </div>
          <div style="flex:1;min-width:0;font-size:11px;color:var(--meta);line-height:1.5;">
            <div>OK ${okPct} · p50 ${p50} · ${s.nodeCount} 节点 · ${s.regionCount} 地区</div>
            <div style="margin-top:2px;color:${expireColor};">到期 ${escapeHtml(expireTxt)}</div>
          </div>
        </div>
        ${uniqueLine}
      </div>`;
    }).join('');
    return true;
  } catch (e) {
    document.getElementById('renewal-list').innerHTML = '<span class="empty">加载失败: ' + e.message + '</span>';
    return false;
  }
}

// ---------- 8 张 24h 趋势图(监测的核心价值) ----------
// hours: 24 / 168 / 720 — 控制时间窗,服务端按对应 bucket 预聚合
async function renderCharts(hours = 24) {
  const bucketMin = HOURS_BUCKET_MIN[hours] || 15;
  try {
    let items;
    try {
      const entry = await fetchJSON(`/api/history?device=${currentDevice}&hours=${hours}`);
      items = entry.data.items;
    } catch (e) {
      console.error('renderCharts fetch failed:', e);
      return false;
    }
    // 引用相同 → 服务端 304 命中,9 张图(8 趋势 + 1 协议)全部跳过 chartUpdate
    if (items === lastDataRef.history) {
      return false;
    }
    lastDataRef.history = items;
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
    return true;
  } catch (e) {
    console.error('renderCharts failed:', e);
    return false;
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

// "节点延迟"折线图 — p15 / p50 / p95 / p99 四条分位线
// p15 (灰虚线) = 低分位参考,p50 (蓝) = 典型,p95 (橙) = 慢侧,p99 (红虚线) = 长尾
// TODO(App 端): 当前 summary.latency 只在 App 端样本里算了 p50/p95,
//   p15/p99 暂时来自 seed(本地)或为 null(生产),需要 App 端在 sample 计算时一起算进去
function drawLatency(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    if (it.summary?.latency) byTs.set(bucketKey(it.ts, bucketMin), it);
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const p15 = series.map(it => it.summary.latency.p15);
  const p50 = series.map(it => it.summary.latency.p50);
  const p95 = series.map(it => it.summary.latency.p95);
  const p99 = series.map(it => it.summary.latency.p99);
  chartUpdate('chart-latency', 'latency', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'p15', data: p15, borderColor: COLORS.secondary, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2, borderDash: [4, 3] },
        { label: 'p50', data: p50, borderColor: COLORS.primary, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2 },
        { label: 'p95', data: p95, borderColor: COLORS.warn, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2 },
        { label: 'p99', data: p99, borderColor: COLORS.err, backgroundColor: 'transparent', tension: 0.25, pointRadius: 2, borderDash: [4, 3] },
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

// 订阅源连通性:X=时间,每订阅源一条折线(每个 sub 的失败节点数随时间变化)
// OK 比例已由 chart-sub-ok-rate 覆盖,这里只画失败数避免重复
function drawSubConn(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    if (it.summary?.subLineStats) byTs.set(bucketKey(it.ts, bucketMin), it);
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const subList = collectSubsAcrossSeries(series);
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const datasets = subList.map(([url, flag], i) => {
    const data = series.map(it => {
      const st = it.summary.subLineStats?.[url];
      if (!st) return null;
      return Math.max(0, (st.total ?? 0) - (st.ok ?? 0));
    });
    return {
      label: flag, data,
      borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
      backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length] + '22', // 12% alpha for fill
      tension: 0.25, spanGaps: true,
      pointRadius: 2, pointHoverRadius: 4,
      fill: false,
    };
  });
  chartUpdate('chart-sub-conn', 'subConn', {
    type: 'line', data: { labels, datasets },
    options: chartOpts({ y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } })
  });
}

// 失败节点数:X=时间,各地区一条折线(各 region 失败节点数随时间变化)
// 按 regionStats.total 比例估算(精确的 subRegionFailStats 是 per-snapshot 数据,这里不复用)
function drawFailCount(items, bucketMin) {
  const byTs = new Map();
  items.forEach(it => {
    const key = bucketKey(it.ts, bucketMin);
    if (it.kind === 'probe' || !byTs.has(key)) byTs.set(key, it);
  });
  const series = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  // 失败数用 subLineStats 各 sub 的 (total-ok) 求和(比 lineOkCount/lineTotalCount 更细粒度)
  const regionSet = new Set();
  series.forEach(it => Object.keys(it.summary?.regionStats || {}).forEach(r => regionSet.add(r)));
  const regions = [...regionSet].sort();
  const labels = series.map(it => formatTime(it.ts, currentHours));
  const datasets = regions.map((region, i) => {
    const data = series.map(it => {
      const s = it.summary || {};
      // 1) 先算每个时间点全网失败数(优先 subLineStats 求和,没有再退化到 lineOk/lineTotal)
      let totalFail = null;
      if (s.subLineStats && typeof s.subLineStats === 'object') {
        const sum = Object.values(s.subLineStats).reduce((acc, st) => {
          const tot = st?.total || 0;
          const ok = st?.ok || 0;
          return acc + Math.max(0, tot - ok);
        }, 0);
        if (sum > 0) totalFail = sum;
      }
      if (totalFail == null && typeof s.lineTotalCount === 'number' && typeof s.lineOkCount === 'number') {
        totalFail = Math.max(0, s.lineTotalCount - s.lineOkCount);
      }
      if (totalFail == null) return null;
      // 2) 按 regionStats 比例分摊
      const regionStats = s.regionStats || {};
      const regionTotal = regionStats[region]?.total || 0;
      const sumTotal = Object.values(regionStats).reduce((a, r) => a + (r?.total || 0), 0);
      if (sumTotal <= 0) return null;
      return Math.round(totalFail * regionTotal / sumTotal);
    });
    return {
      label: region, data,
      borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
      backgroundColor: 'transparent',
      tension: 0.25, spanGaps: true,
      pointRadius: 2, pointHoverRadius: 4,
    };
  });
  chartUpdate('chart-fail-count', 'failCount', {
    type: 'line', data: { labels, datasets },
    options: chartOpts({ y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } })
  });
}

// ---------- 共享工具:per-sub / per-region 数据抽取 ----------
// 取最新一条(优先 full)
function pickLatestItem(items) {
  if (!items || items.length === 0) return null;
  // 优先 full,然后按 ts 倒序取最大
  const sorted = [...items].sort((a, b) => {
    if ((a.kind === 'full') !== (b.kind === 'full')) return a.kind === 'full' ? -1 : 1;
    return b.ts - a.ts;
  });
  return sorted[0];
}

// 从 summary.subLineStats 抽出 [[url, flag]] 列表,按 flag 字典序稳定排序
function getSubList(summary) {
  if (!summary || !summary.subLineStats) return [];
  return Object.entries(summary.subLineStats)
    .map(([url, st]) => [url, (st.flag || url).slice(0, 6)])
    .sort((a, b) => a[1].localeCompare(b[1]));
}

// 在一段时间序列里收集所有出现过的订阅源(按 flag 字典序)
function collectSubsAcrossSeries(series) {
  const map = new Map();
  series.forEach(it => {
    const s = it.summary || {};
    if (s.subLineStats) {
      Object.entries(s.subLineStats).forEach(([url, st]) => {
        if (!map.has(url)) map.set(url, (st.flag || url).slice(0, 6));
      });
    }
  });
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

// 给定 summary + subList,产出 Map<url, Map<region, failedCount>>
// 优先用 summary.subRegionFailStats[url][region] = failedCount(精确)
// 缺失时按 subLineStats 算出每个 sub 的失败数,再按 regionStats.total 比例分摊
function buildSubRegionFailures(summary, subList) {
  const out = new Map();
  if (!summary) return out;
  subList.forEach(([url]) => out.set(url, {}));

  // 1) 优先:精确字段
  if (summary.subRegionFailStats && typeof summary.subRegionFailStats === 'object') {
    subList.forEach(([url]) => {
      const byRegion = summary.subRegionFailStats[url];
      if (byRegion && typeof byRegion === 'object') {
        Object.entries(byRegion).forEach(([r, n]) => {
          if (typeof n === 'number' && n > 0) {
            out.get(url)[r] = (out.get(url)[r] || 0) + n;
          }
        });
      }
    });
    return out;
  }

  // 2) 退化:按 subLineStats[url] 算失败数,再按 regionStats.total 比例分摊
  const regionStats = summary.regionStats || {};
  const regions = Object.keys(regionStats);
  const sumRegionTotal = regions.reduce((a, r) => a + (regionStats[r]?.total || 0), 0);
  subList.forEach(([url]) => {
    const st = summary.subLineStats?.[url];
    if (!st) return;
    const failed = Math.max(0, (st.total ?? 0) - (st.ok ?? 0));
    if (failed === 0) return;
    if (sumRegionTotal <= 0 || regions.length === 0) {
      // 没有 region 数据,挂到"未知"桶
      out.get(url)['未知'] = (out.get(url)['未知'] || 0) + failed;
      return;
    }
    // 比例分摊 + 整数化 + 余数修正(最后那个 region 吃 diff 保持 sum 一致)
    const allocations = regions.map(r => ({
      r,
      exact: failed * (regionStats[r]?.total || 0) / sumRegionTotal,
    }));
    const rounded = allocations.map(a => Math.floor(a.exact));
    const remainder = failed - rounded.reduce((a, n) => a + n, 0);
    if (remainder > 0 && rounded.length > 0) {
      // 把余数加到比例最大的那个,保证整数求和 = failed
      const topIdx = allocations.reduce((best, a, i) => a.exact - allocations[best].exact > 0 ? i : best, 0);
      rounded[topIdx] += remainder;
    }
    allocations.forEach((a, i) => {
      if (rounded[i] > 0) out.get(url)[a.r] = rounded[i];
    });
  });
  return out;
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
    const tier = v.p50 < 50 ? '优' : (v.p50 < 150 ? '中' : '差');
    return { fill: latencyColor(v.p50), title: `${v.p50}ms · ${tier}` };
  };

  // 4. 把 regionStats key("🇭🇰 HK" 等)归一化成 {ISO → 第一个匹配 region(其余合并)}
  //   - 一个 ISO 可能被多个 region 匹配(理论上不该出现,先收集所有)
  //   - 未知 region 不伪装成中国，地图上不着色
  const isoToRegionInfo = new Map();
  Object.entries(rs).forEach(([region, v]) => {
    if (v.total == null || v.total === 0) return;
    // 剥掉 emoji(用 code-point-aware 的方式,flag 是两个 regional indicator)
    const code = region.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim().toUpperCase();
    let iso = REGION_TO_ISO[code];
    if (!iso) return;
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
    const data = await res.json().catch(() => ({}));
    noteQuotaFailure(data);
    if (!res.ok) throw new Error(data.message || 'HTTP ' + res.status);
    if (!Array.isArray(data.bills)) throw new Error('账本响应格式异常');
    bills = data.bills;
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
  // 图表已渲染(无论新建还是更新)→ 隐藏 chart-wrap 里的 skeleton 占位
  // 早 return(failed / 304 / 无数据)不会调到 chartUpdate,skeleton 保持显示 — 正是想要的效果
  if (ctx && ctx.parentElement) {
    ctx.parentElement.classList.add('is-loaded');
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
    const isOk = l.probe?.status === 'OK';
    // 共享节点计入每个 uid,与 agent 端 uidStats / widget linesByUid 口径一致
    (l.uidTag || '').split(',').forEach(tag => {
      const uid = tag.trim();
      if (!uid) return;
      if (!stats[uid]) stats[uid] = { ok: 0, total: 0 };
      stats[uid].total++;
      if (isOk) stats[uid].ok++;
    });
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

// ---------- Quiet hours (静默时段) ----------
// 分钟数 (0..1439) → "HH:MM" 字符串(24h,前导零)
function formatMinutes(m) {
  const mm = Math.max(0, Math.min(1439, Math.floor(m) || 0));
  return String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
}
// "HH:MM" → 分钟数(无效返回 null)
function parseTimeInput(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}
// 当前设备时间是否落在 [start, end) 内
//   start == end → 禁用,永远 false
//   start <  end → 同一天窗口
//   start >  end → 跨午夜(now >= start || now < end)
function isInQuietMinutes(now, start, end) {
  if (start == null || end == null) return false;
  if (start === end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return start < end ? (minute >= start && minute < end) : (minute >= start || minute < end);
}
// 找当前 device 记录(用于弹层 / 角标 / footer 状态)
function getCurrentDeviceRecord() {
  if (!currentDevice) return null;
  return devices.find(d => d.uuid === currentDevice) || null;
}
// 设备切换后:刷新角标 + footer 状态 + 弹层(若开着)
function onCurrentDeviceChanged() {
  recomputeQuietBadge();
  recomputeQuietStatus();
  // 弹层开着就重新预填(用户改 device 时弹层若开着要更新)
  const dlg = document.getElementById('quiet-hours-dialog');
  if (dlg && dlg.open) {
    const d = getCurrentDeviceRecord();
    if (d) {
      document.getElementById('quiet-hours-device-name').textContent = d.name;
      document.getElementById('quiet-hours-start').value = formatMinutes(d.quietHourStart ?? QUIET_DEFAULT_START);
      document.getElementById('quiet-hours-end').value = formatMinutes(d.quietHourEnd ?? QUIET_DEFAULT_END);
      document.getElementById('quiet-hours-error').hidden = true;
    }
  }
}
// 设备名旁的角标(🌙 00:00-08:00)— start==end 隐藏
function recomputeQuietBadge() {
  const el = document.getElementById('device-quiet-badge');
  if (!el) return;
  const d = getCurrentDeviceRecord();
  if (!d) { el.hidden = true; el.textContent = ''; return; }
  const start = d.quietHourStart;
  const end = d.quietHourEnd;
  if (start == null || end == null || start === end) {
    el.hidden = true;
    el.textContent = '';
  } else {
    el.textContent = '🌙 ' + formatMinutes(start) + '-' + formatMinutes(end);
    el.hidden = false;
  }
}
// footer 状态行:在静默窗口内显示一行提示
function recomputeQuietStatus() {
  const el = document.getElementById('quiet-hours-status');
  if (!el) return;
  const d = getCurrentDeviceRecord();
  if (!d) { el.hidden = true; el.textContent = ''; return; }
  const start = d.quietHourStart;
  const end = d.quietHourEnd;
  if (start == null || end == null || start === end) {
    el.hidden = true; el.textContent = '';
    return;
  }
  if (isInQuietMinutes(new Date(), start, end)) {
    el.textContent = `🌙 静默时段中(${formatMinutes(start)}-${formatMinutes(end)}),Agent 本地测活正常,云端暂停上报。`;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}
let quietHoursTimer = null;
function startQuietHoursTimer() {
  if (quietHoursTimer) return;
  // 立即算一次,然后每分钟重算
  recomputeQuietStatus();
  quietHoursTimer = setInterval(recomputeQuietStatus, 60_000);
}

function wireQuietHours() {
  const btn = document.getElementById('device-settings-btn');
  if (btn) btn.addEventListener('click', openQuietHoursDialog);
  const save = document.getElementById('quiet-hours-save');
  if (save) save.addEventListener('click', saveQuietHours);
  const reset = document.getElementById('quiet-hours-reset');
  if (reset) reset.addEventListener('click', () => {
    document.getElementById('quiet-hours-start').value = formatMinutes(QUIET_DEFAULT_START);
    document.getElementById('quiet-hours-end').value = formatMinutes(QUIET_DEFAULT_END);
    document.getElementById('quiet-hours-error').hidden = true;
  });
  const cancel = document.getElementById('quiet-hours-cancel');
  if (cancel) cancel.addEventListener('click', closeQuietHoursDialog);
}

function openQuietHoursDialog() {
  if (!currentDevice) return;
  const d = getCurrentDeviceRecord();
  if (!d) return;
  const dlg = document.getElementById('quiet-hours-dialog');
  if (!dlg) return;
  document.getElementById('quiet-hours-device-name').textContent = d.name;
  document.getElementById('quiet-hours-start').value = formatMinutes(d.quietHourStart ?? QUIET_DEFAULT_START);
  document.getElementById('quiet-hours-end').value = formatMinutes(d.quietHourEnd ?? QUIET_DEFAULT_END);
  document.getElementById('quiet-hours-error').hidden = true;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeQuietHoursDialog() {
  const dlg = document.getElementById('quiet-hours-dialog');
  if (!dlg) return;
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  else dlg.removeAttribute('open');
}

function showQuietHoursError(text) {
  const el = document.getElementById('quiet-hours-error');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}

async function saveQuietHours() {
  if (!currentDevice) return;
  const startVal = document.getElementById('quiet-hours-start').value;
  const endVal = document.getElementById('quiet-hours-end').value;
  const start = parseTimeInput(startVal);
  const end = parseTimeInput(endVal);
  if (start == null || end == null) {
    showQuietHoursError('时间格式无效,需为 HH:MM');
    return;
  }
  // 强制 5min 步进(input step=300 已经在 UI 限制,这里再 defense-in-depth 一次)
  if (start % 5 !== 0 || end % 5 !== 0) {
    showQuietHoursError('必须是 5 分钟步进');
    return;
  }
  const errEl = document.getElementById('quiet-hours-error');
  errEl.hidden = true;
  const saveBtn = document.getElementById('quiet-hours-save');
  saveBtn.disabled = true;
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(currentDevice)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Uuid': currentDevice,
      },
      body: JSON.stringify({ quietHourStart: start, quietHourEnd: end }),
    });
    if (!res.ok) {
      let display = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error) display = j.error;
      } catch { /* not json */ }
      showQuietHoursError('保存失败: ' + display);
      return;
    }
    const updated = await res.json();
    // 乐观更新内存里的 device 记录(API 600s 边缘缓存,等不等 GET 都行)
    const d = getCurrentDeviceRecord();
    if (d) {
      if (typeof updated.quietHourStart === 'number') d.quietHourStart = updated.quietHourStart;
      if (typeof updated.quietHourEnd === 'number') d.quietHourEnd = updated.quietHourEnd;
    }
    closeQuietHoursDialog();
    recomputeQuietBadge();
    recomputeQuietStatus();
    setFooter(`静默时段已保存 · ${formatMinutes(start)}-${formatMinutes(end)}`, true);
  } catch (e) {
    showQuietHoursError('保存失败: ' + (e && e.message ? e.message : String(e)));
  } finally {
    saveBtn.disabled = false;
  }
}
