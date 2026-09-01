#!/usr/bin/env node
// 拉远程 D1 的真实数据到本地 D1,做"仿真"本地预览用
// 用法: npm run db:pull
//
// 流程:
//   1. wrangler d1 export --remote   → scripts/.cache/remote-dump.sql
//   2. 清空本地 D1 的 4 张表(DELETE FROM,保留 schema)
//   3. wrangler d1 execute --local --file → 导入
//
// 前提:已 `wrangler login`(或设置 CLOUDFLARE_API_TOKEN),且对 tunnelwatch 这个 D1
// 有读权限。导出文件落在 .cache/ 目录(已在 .gitignore)。
//
// 为什么不用 seed.mjs 假数据:真实设备 + 真实快照才能暴露真实的渲染/性能/边界问题,
// 假数据(6 个固定 sub、确定性失败序列)只能验证 happy path,不能验证"用户那台 OnePlus
// 到底发生了什么"。所有本地预览、UI 验证、回归测试都应该基于本脚本拉的真数据。

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(__dirname, '.cache');
const DUMP_FILE = join(CACHE_DIR, 'remote-dump.sql');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.status !== 0) {
    console.error(`\n✗ Command failed (exit ${res.status}): ${cmd} ${args.join(' ')}`);
    process.exit(res.status || 1);
  }
}

function captureOut(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`✗ Command failed: ${cmd} ${args.join(' ')}\n${res.stderr || ''}`);
    process.exit(res.status || 1);
  }
  return res.stdout;
}

console.log('→ [1/4] 导出远程 D1 → .cache/remote-dump.sql');
mkdirSync(CACHE_DIR, { recursive: true });
// --no-schema:只导数据。本地 schema 来自 migrations/,不能跟 dump 里的 CREATE TABLE 冲突
run('npx', ['wrangler', 'd1', 'export', 'tunnelwatch', '--remote', '--no-schema', '--output', DUMP_FILE]);

if (!existsSync(DUMP_FILE)) {
  console.error('✗ 导出文件未生成:', DUMP_FILE);
  console.error('  可能原因:没 wrangler login / 没这个 D1 的读权限 / 网络问题');
  process.exit(1);
}
const size = readFileSync(DUMP_FILE).length;
console.log(`  ✓ 导出完成 (${(size / 1024).toFixed(1)} KB)\n`);

console.log('→ [2/4] 清空本地 D1 的 4 张表(保留 schema)');
// 顺序按外键依赖倒序:bill_share_filters → bills → snapshots → devices
const tables = ['bill_share_filters', 'bills', 'snapshots', 'devices'];
for (const t of tables) {
  run('npx', ['wrangler', 'd1', 'execute', 'tunnelwatch', '--local', '-y',
    '--command', `DELETE FROM ${t};`]);
}
console.log('');

console.log('→ [3/4] 导入到本地 D1');
run('npx', ['wrangler', 'd1', 'execute', 'tunnelwatch', '--local', '-y', '--file', DUMP_FILE]);
console.log('');

console.log('→ [4/4] 设备列表:');
const out = captureOut('npx', [
  'wrangler', 'd1', 'execute', 'tunnelwatch', '--local', '-y',
  '--command', `SELECT uuid, name, created_at FROM devices ORDER BY created_at;`,
]);
const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('Executing') && !l.startsWith('┌') && !l.startsWith('└'));
if (lines.length > 0) {
  // 表格的第二行起就是数据(第一行是表头)
  lines.slice(1).forEach(l => console.log('  ' + l.trim()));
} else {
  console.log('  (无设备)');
}

console.log('\n✓ 本地 D1 已就绪真实数据。启动: npm run dev');
