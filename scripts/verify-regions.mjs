import fs from 'node:fs';
import { buildRegionStats, isNonNodeLine, parseRegionCode, regionLabel } from '../functions/api/_regions.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/verify-regions.mjs <latest.json>');
  process.exit(2);
}

const snapshot = JSON.parse(fs.readFileSync(input, 'utf8'));
const lines = snapshot?.payload?.lines || [];
const stats = buildRegionStats(lines);
const unparsed = lines.filter((line) => !isNonNodeLine(line?.name) && !parseRegionCode(line?.name));
const excluded = lines.filter((line) => isNonNodeLine(line?.name));
const classified = lines.length - excluded.length - unparsed.length;

console.log(`节点 ${lines.length} · 已分类 ${classified} · 非节点 ${excluded.length} · 未解析 ${unparsed.length}`);
for (const [region, value] of Object.entries(stats).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`${region.padEnd(8)} ${String(value.total).padStart(3)} 节点 · ${String(value.ok).padStart(3)} OK · p50 ${value.p50 ?? '—'}ms`);
}
if (excluded.length) {
  console.log('\n已排除的公告节点:');
  excluded.forEach((line) => console.log(`  - ${line.name}`));
}
if (unparsed.length) {
  console.log('\n未解析(不参与地区分布):');
  unparsed.forEach((line) => console.log(`  - ${line.name}`));
}

const expected = classified;
const actual = Object.values(stats).reduce((sum, value) => sum + value.total, 0);
if (actual !== expected) throw new Error(`守恒校验失败: ${actual} != ${expected}`);

// 输出几个容易回归的规则结果，便于人工核对。
for (const sample of ['🇭🇰 [三网]HK 01', '🇺🇸 [Hy2]US 01', 'hy2台湾01', '🇨🇳台湾专线01|BGP', '[Hy2][0.1x]EMBY 01']) {
  console.log(`RULE ${sample} => ${regionLabel(parseRegionCode(sample))}`);
}
