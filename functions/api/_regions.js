const REGION_DEFS = [
  ['HK', '🇭🇰', ['香港', '港服', '港区', 'hong kong', 'hongkong']],
  ['JP', '🇯🇵', ['日本', '东京', '大阪', 'japan', 'tokyo', 'osaka']],
  ['TW', '🇹🇼', ['台湾', '臺灣', '台北', '臺北', 'taiwan', 'taipei']],
  ['SG', '🇸🇬', ['新加坡', '狮城', 'singapore']],
  ['KR', '🇰🇷', ['韩国', '韓國', '首尔', '首爾', 'south korea', 'korea', 'seoul']],
  ['US', '🇺🇸', ['美国', '美國', '美西', '美东', '美東', '洛杉矶', '硅谷', 'united states', 'america']],
  ['CA', '🇨🇦', ['加拿大', '多伦多', '多倫多', 'canada', 'toronto']],
  ['UK', '🇬🇧', ['英国', '英國', '伦敦', '倫敦', 'united kingdom', 'britain', 'london']],
  ['FR', '🇫🇷', ['法国', '法國', '巴黎', 'france', 'paris']],
  ['DE', '🇩🇪', ['德国', '德國', '法兰克福', '法蘭克福', 'germany', 'frankfurt']],
  ['IN', '🇮🇳', ['印度', 'india', 'mumbai']],
  ['ID', '🇮🇩', ['印度尼西亚', '印尼', 'indonesia', 'jakarta']],
  ['VN', '🇻🇳', ['越南', 'vietnam']],
  ['AU', '🇦🇺', ['澳大利亚', '澳大利亞', '澳洲', '悉尼', 'australia', 'sydney']],
  ['TR', '🇹🇷', ['土耳其', 'turkey', 'türkiye']],
  ['MY', '🇲🇾', ['马来西亚', '馬來西亞', '马来', '馬來', 'malaysia']],
  ['TH', '🇹🇭', ['泰国', '泰國', 'thailand', 'bangkok']],
  ['CN', '🇨🇳', ['中国大陆', '中國大陸', '中国', '中國', '大陆', '大陸', 'mainland china']],
];

const REGION_BY_CODE = new Map(REGION_DEFS.map(([code, emoji, aliases]) => [code, { code, emoji, aliases }]));
const FLAG_TO_CODE = new Map(REGION_DEFS.map(([code, emoji]) => [emoji, code]));

const NON_NODE_PATTERNS = [
  /(?:https?:\/\/)?t\.me\//i,
  /(?:https?:\/\/)?github\.com\//i,
  /电报群|電報群|防失联|防失聯/i,
  /官网使用文档|官網使用文檔|更新订阅|更新訂閱|下载最新的客户端|下載最新的客戶端/i,
  /用不了.*换个客户端|用不了.*換個客戶端/i,
];

export function isNonNodeLine(name) {
  if (typeof name !== 'string' || !name.trim()) return true;
  return NON_NODE_PATTERNS.some((pattern) => pattern.test(name));
}

export function parseRegionCode(name) {
  if (isNonNodeLine(name)) return null;
  const raw = name.trim();
  const lower = raw.toLocaleLowerCase('en-US');

  // 地区全称/城市语义比装饰国旗可靠。例如真实数据中有“🇨🇳台湾专线”。
  // 长别名优先，避免“印度尼西亚”先命中“印度”。
  const aliases = REGION_DEFS.flatMap(([code, , values]) => values.map((value) => [value, code]));
  aliases.sort((a, b) => b[0].length - a[0].length);
  const aliasHit = aliases.find(([alias]) => lower.includes(alias));
  if (aliasHit) return aliasHit[1];

  // ISO 必须有非字母边界，支持 [三网]HK、[Hy2]US、vip-SG01，拒绝 EMBY 中的 MB。
  const upper = raw.toUpperCase();
  for (const [code] of REGION_DEFS) {
    const pattern = new RegExp(`(^|[^A-Z])${code}(?=$|[^A-Z])`);
    if (pattern.test(upper)) return code;
  }

  // 国旗可在任意位置；放在明确语义之后处理冲突命名。
  for (const [flag, code] of FLAG_TO_CODE) {
    if (raw.includes(flag)) return code;
  }
  return null;
}

export function regionLabel(code) {
  const def = REGION_BY_CODE.get(code);
  return def ? `${def.emoji} ${def.code}` : '🌐 其他';
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[index].latency;
}

export function buildRegionStats(lines) {
  const buckets = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const name = typeof line?.name === 'string' ? line.name.trim() : '';
    if (isNonNodeLine(name)) continue;
    const code = parseRegionCode(name);
    // 没有任何地区证据的节点不参与“地区分布”；不能把协议/用途标签伪装成一个地区。
    if (!code) continue;
    const label = regionLabel(code);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(line);
  }

  const stats = {};
  for (const [label, regionLines] of buckets) {
    const successful = regionLines
      .filter((line) => String(line?.probe?.status || '').toUpperCase() === 'OK' && Number.isFinite(line?.probe?.ms))
      .map((line) => ({ name: line.name, latency: Number(line.probe.ms) }))
      .sort((a, b) => a.latency - b.latency);
    stats[label] = {
      ok: successful.length,
      total: regionLines.length,
      p50: percentile(successful, 0.5),
      p95: percentile(successful, 0.95),
      fastest: successful[0] || null,
      slowest: successful[successful.length - 1] || null,
    };
  }
  return stats;
}

export function normalizeSnapshotSummary(summary, payload) {
  const base = summary && typeof summary === 'object' ? { ...summary } : {};
  const lines = payload && typeof payload === 'object' ? payload.lines : null;
  if (!Array.isArray(lines) || lines.length === 0) return base;
  const regionStats = buildRegionStats(lines);
  base.regionStats = regionStats;
  base.regionBalance = Object.entries(regionStats).map(([region, value]) => ({
    region,
    count: value.total,
    okRate: value.total > 0 ? value.ok / value.total : 0,
    p50: value.p50,
    status: value.total >= 25 ? 'abundant' : value.total >= 8 ? 'sufficient' : 'scarce',
  }));
  return base;
}
