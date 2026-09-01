// TunnelWatch 状态面板 — 前端逻辑
// - 拉 /api/devices 填充下拉
// - 拉 /api/latest 渲染卡片镜像
// - 拉 /api/history 渲染 4 张图
// - 60 秒自动刷新

const REFRESH_MS = 60_000;
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
let currentRegionSort = 'desc'; // 按地区 排序:'desc' 充裕在前(节点数多)/ 'asc' 稀缺在前
let charts = {
  okRate: null, subOkRate: null, traffic: null, latency: null,
  subConn: null, regionLatency: null, protocol: null,
  failCount: null, trafficRate: null,
};

// 时间窗 → 服务端桶大小(分钟)
const HOURS_BUCKET_MIN = { 24: 15, 168: 60, 720: 240 };
// 时间窗 → 卡片标题显示(24h / 7d / 30d)
const HOURS_LABEL = { 24: '24h', 168: '7d', 720: '30d' };

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
  wireViewSwitcher();
  wireRegionSortSwitcher();
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
    refreshAll();
  });
}

// "按地区" 卡片头右侧的 "↓ 节点数 / ↑ 节点数" 切换 — 切排序后只重渲这一张卡
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
    });
    // 默认选上次记忆的,否则第一个
    const remembered = localStorage.getItem('tw_device');
    const target = devices.find(d => d.uuid === remembered) || devices[0];
    sel.value = target.uuid;
    currentDevice = target.uuid;
    await refreshAll();
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
    //   desc(默认 · 充裕在前):count desc,然后 status desc
    //   asc(稀缺在前):count asc,然后 status asc
    const dir = currentRegionSort === 'desc' ? 1 : -1;
    entries.sort((a, b) => {
      const dr = (b[1].total - a[1].total) * dir;
      if (dr !== 0) return dr;
      return (statusRank[statusOf(b[1])] - statusRank[statusOf(a[1])]) * dir;
    });
    // 切换 tab 时同步右侧 hint 文案
    const hint = document.getElementById('region-hint');
    if (hint) {
      hint.textContent = currentRegionSort === 'desc'
        ? '充裕在前 · 节点数降序'
        : '稀缺在前 · 节点数升序';
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
      const R = 14;                       // ring radius
      const C = 2 * Math.PI * R;          // circumference
      const okLen = (pct * C).toFixed(2);
      const failLen = (C - pct * C).toFixed(2);
      let failColor = '#E5E7EB';           // 浅灰(>80%)
      if (pct < 0.5) failColor = COLORS.err;
      else if (pct < 0.8) failColor = COLORS.warn;
      // 全绿时只画一段;否则 OK 段在前(从 12 点方向顺时针),失败段接上
      const ringSvg = (pct >= 1)
        ? `<svg viewBox="0 0 36 36" width="44" height="44">
             <circle cx="18" cy="18" r="${R}" fill="none" stroke="${COLORS.ok}" stroke-width="4"/>
           </svg>`
        : `<svg viewBox="0 0 36 36" width="44" height="44">
             <circle cx="18" cy="18" r="${R}" fill="none" stroke="${failColor}" stroke-width="4"/>
             <circle cx="18" cy="18" r="${R}" fill="none" stroke="${COLORS.ok}" stroke-width="4"
                     stroke-dasharray="${okLen} ${failLen}" stroke-dashoffset="${(C / 4).toFixed(2)}"
                     transform="rotate(-90 18 18)" stroke-linecap="butt"/>
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
          <span class="rr-ring-label"><span>${v.ok}</span><span class="rr-ring-total">/${v.total}</span></span>
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
    document.getElementById('renewal-list').innerHTML = scores.map(s => {
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
      // 12x12 方块图例 — 跟整体视觉一致(同 .empty 块、bar 图例风格)
      // line chart 在 Chart.js v4 自动画"线 + 中点",不会因为 boxWidth 大就变"口"
      legend: { display: true, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, font: { size: 12 }, color: COLORS.axis, padding: 8 } },
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
