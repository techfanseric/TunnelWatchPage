#!/usr/bin/env node
// Seed 本地 D1:24h 假数据 + 1 个授权设备
// 用法:
//   DEVICE_UUID=<你的设备 UUID> DEVICE_NAME=MyPhone npm run db:seed
// 例:
//   DEVICE_UUID=69af700e-0242-4d1a-acd6-9e9ff802f2bd DEVICE_NAME="OnePlus PHK110" npm run db:seed
//
// 不传 DEVICE_UUID 会拒绝执行(避免误插 mock 设备)
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEVICE_UUID = process.env.DEVICE_UUID;
const DEVICE_NAME = process.env.DEVICE_NAME || 'Device';

if (!DEVICE_UUID) {
  console.error('DEVICE_UUID env var is required.\n' +
    '例: DEVICE_UUID=69af700e-0242-4d1a-acd6-9e9ff802f2bd DEVICE_NAME="OnePlus PHK110" npm run db:seed');
  process.exit(1);
}
console.log(`Seeding for device: ${DEVICE_NAME} (${DEVICE_UUID})`);

const statements = [];
statements.push(
  `INSERT OR REPLACE INTO devices (uuid, name) VALUES ('${DEVICE_UUID}', '${DEVICE_NAME}');`
);

const uids = ['momo', 'big', 'stl'];
const uidTotal = { momo: 14, big: 9, stl: 5 };
const totalLines = uidTotal.momo + uidTotal.big + uidTotal.stl;
const totalSubs = 6;

// 6 个订阅源 + flag + 节点数(28 总数刚好分完)
const subs = [
  { flag: 'momo-A', url: 'https://sub1.momo.example/api/v1', lines: 7 },
  { flag: 'momo-B', url: 'https://sub2.momo.example/api/v1', lines: 7 },
  { flag: 'big-A',  url: 'https://sub1.big.example/link',     lines: 5 },
  { flag: 'big-B',  url: 'https://sub2.big.example/link',     lines: 4 },
  { flag: 'stl-A',  url: 'https://sub.stl.example/x',         lines: 3 },
  { flag: 'stl-B',  url: 'https://sub2.stl.example/y',        lines: 2 },
];

// 给每个 sub 的每条 line 分配一个 region(顺序固定 → 失败顺序也确定 → 数据可对照)
// 下面这一段是 subRegionFailStats / regionStats 的"真实数据源";
// 没有 region 信息的子集会自动用估算回退(app.js buildSubRegionFailures)
const subLineRegions = {
  'https://sub1.momo.example/api/v1': ['HK', 'HK', 'JP', 'JP', 'US', 'US', 'SG'],
  'https://sub2.momo.example/api/v1': ['JP', 'JP', 'HK', 'HK', 'US', 'US', 'SG'],
  'https://sub1.big.example/link':    ['US', 'US', 'HK', 'JP', 'SG'],
  'https://sub2.big.example/link':    ['HK', 'JP', 'US', 'SG'],
  'https://sub.stl.example/x':        ['JP', 'US', 'US'],
  'https://sub2.stl.example/y':       ['HK', 'SG'],
};
// region 汇总(每个 region 的总节点数)— 与 subLineRegions 各 sub 长度求和一致
//   HK: momo-A×2 + momo-B×2 + big-A×1 + big-B×1 + stl-B×1 = 7
//   JP: momo-A×2 + momo-B×2 + big-A×1 + big-B×1 + stl-A×1 = 7
//   US: momo-A×2 + momo-B×2 + big-A×2 + big-B×1 + stl-A×2 = 9
//   SG: momo-A×1 + momo-B×1 + big-A×1 + big-B×1 + stl-B×1 = 5
//   合计 7+7+9+5 = 28
const REGION_TOTALS = { HK: 7, JP: 7, US: 9, SG: 5 };

// 简单 LCG 给确定性(每次跑数据一样,方便对照)
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

for (let i = 0; i < 49; i++) {
  const hoursAgo = 24 - i * 0.5;
  const tsExpr = `(unixepoch() - ${Math.floor(hoursAgo * 3600)}) * 1000`;

  // per-sub OK 分布(更细致,给 per-sub 图表用)
  // 默认所有 sub 全 OK,有特定 i 时让特定 sub 掉线
  const subLineStats = {};
  const subRegionFailStats = {};   // 给"订阅源连通性"快照图用的真实字段
  const uidFailAccum = { momo: 0, big: 0, stl: 0 };  // 按 uid 累加失败数,后面汇总成 lineOk
  subs.forEach((sub, idx) => {
    let okCount = sub.lines;
    // 模拟各 sub 偶发掉线
    if (idx === 0 && (i === 30 || i === 32)) okCount = Math.max(0, sub.lines - 6); // momo-A 跟 momo 同步掉
    if (idx === 1 && i === 30) okCount = Math.max(0, sub.lines - 5);
    if (idx === 2 && i === 18) okCount = Math.max(0, sub.lines - 3);
    if (idx === 3 && i === 18) okCount = Math.max(0, sub.lines - 2);
    if (idx === 4 && i === 38) okCount = Math.max(0, sub.lines - 2);
    if (idx === 5 && i === 12) okCount = Math.max(0, sub.lines - 1);
    subLineStats[sub.url] = { ok: okCount, total: sub.lines, flag: sub.flag };

    // 把"失败的 line"按 region 归类(取前 failedCount 行,顺序由 subLineRegions 决定)
    const failCount = sub.lines - okCount;
    const regions = subLineRegions[sub.url] || [];
    const byRegion = {};
    for (let k = 0; k < failCount && k < regions.length; k++) {
      const r = regions[k];
      byRegion[r] = (byRegion[r] || 0) + 1;
    }
    if (Object.keys(byRegion).length > 0) subRegionFailStats[sub.url] = byRegion;
    // 按 uid 累加(用于后面 lineOk/uidStats)— 用 sub 的 flag 前缀区分 uid
    const uidTag = sub.flag.split('-')[0];
    if (uidFailAccum[uidTag] != null) uidFailAccum[uidTag] += failCount;
  });

  // 由 subLineStats 求和得到 lineOk/uidStats(保持一致,避免出现 6 vs 11 这种自相矛盾)
  const uidStats = {};
  for (const [uid, total] of Object.entries(uidTotal)) {
    const ok = Math.max(0, total - (uidFailAccum[uid] || 0));
    uidStats[uid] = { ok, total };
  }
  const lineOk = Object.values(uidStats).reduce((a, s) => a + s.ok, 0);

  // regionStats:按 region 的 p15/p50/p95/p99(取一个稳定基线 + 抖动,便于看趋势)
  // p50 各 region 略有差异:JP 稍快,US 慢一些
  const regionBaseP50 = { HK: 95, JP: 85, US: 165, SG: 120 };
  const regionStats = {};
  Object.entries(REGION_TOTALS).forEach(([r, total]) => {
    const base = regionBaseP50[r] || 120;
    const jitter = rand() * 20 - 10;
    const rP50 = Math.max(20, Math.round(base + jitter));
    const rP15 = Math.round(rP50 * 0.55 + rand() * 6);
    const rP95 = Math.round(rP50 * 1.8 + rand() * 30);
    const rP99 = Math.round(rP95 * 1.45 + rand() * 40);
    regionStats[r] = { total, p15: rP15, p50: rP50, p95: rP95, p99: rP99 };
  });

  const quotaUsed = +(140 + i * 0.25).toFixed(1);
  const quotaTotal = 300;
  const usagePercent = +(quotaUsed / quotaTotal * 100).toFixed(1);

  const baseP50 = 100 + Math.sin(i / 6) * 30 + rand() * 20;
  const baseP95 = baseP50 * 1.8 + rand() * 40;
  // p15 < p50(同分布下),p99 > p95(长尾)
  // 真实分位 = 在样本里排序取对应位置,这里按经验比例近似
  const baseP15 = baseP50 * 0.55 + rand() * 8;
  const baseP99 = baseP95 * 1.45 + rand() * 60;
  const p15 = Math.round(baseP15);
  const p50 = Math.round(baseP50);
  const p95 = Math.round(baseP95);
  const p99 = Math.round(baseP99);

  let ok = totalSubs, timeout = 0, failed = 0;
  if (i === 12) { failed = 2; ok = 4; }
  if (i === 24) { timeout = 1; failed = 1; ok = 4; }
  if (i === 40) { failed = 1; ok = 5; }

  const expireAt = Date.now() + 12 * 24 * 3600 * 1000;
  const subLoadSummary = failed + timeout > 0
    ? `${ok}/${totalSubs} OK · 失败 ${failed} · 超时 ${timeout}`
    : `${ok}/${totalSubs} OK`;

  const baseSummary = {
    online: true,
    serverName: '3账号 · 6订阅',
    quotaUsedGB: quotaUsed,
    quotaTotalGB: quotaTotal,
    usagePercent: usagePercent,
    expireAtMillis: expireAt,
    subLoadSummary: subLoadSummary,
    lineOkCount: lineOk,
    lineTotalCount: totalLines,
    uidTags: uids,
    uidStats: uidStats,
    subLineStats: subLineStats,
    subRegionFailStats: subRegionFailStats,
    regionStats: regionStats,
    latency: { p15: p15, p50: p50, p95: p95, p99: p99, count: totalLines },
    subStats: { ok: ok, timeout: timeout, failed: failed },
  };

  // FULL
  statements.push(
    `INSERT INTO snapshots (device_uuid, device_name, kind, ts, summary_json, payload_json) VALUES (` +
    `'${DEVICE_UUID}', '${DEVICE_NAME}', 'full', ${tsExpr}, ` +
    `'${escape(JSON.stringify(baseSummary))}', ` +
    `'${escape(JSON.stringify({ placeholder: 'full payload', tsExpr }))}');`
  );

  // PROBE(quota 略不同,表示"probe 不更新 quota"的语义)
  const probeSummary = { ...baseSummary, subLoadSummary: `${ok}/${totalSubs} OK` };
  probeSummary.quotaUsedGB = +(quotaUsed - 0.1).toFixed(1);
  probeSummary.usagePercent = +(probeSummary.quotaUsedGB / quotaTotal * 100).toFixed(1);
  statements.push(
    `INSERT INTO snapshots (device_uuid, device_name, kind, ts, summary_json, payload_json) VALUES (` +
    `'${DEVICE_UUID}', '${DEVICE_NAME}', 'probe', ${tsExpr}, ` +
    `'${escape(JSON.stringify(probeSummary))}', ` +
    `'${escape(JSON.stringify({ placeholder: 'probe payload', tsExpr }))}');`
  );
}

const sql = statements.join('\n');
const tmp = join(tmpdir(), `tw-seed-${Date.now()}.sql`);
writeFileSync(tmp, sql, 'utf8');
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'tunnelwatch', '--local', `--file=${tmp}`], {
    stdio: 'inherit',
  });
  console.log(`\n✓ seeded ${statements.length} statements (1 device + 98 snapshots)`);
} catch (e) {
  console.error('seed failed:', e.message);
  process.exit(1);
} finally {
  try { unlinkSync(tmp); } catch {}
}

function escape(s) {
  return s.replace(/'/g, "''");
}
