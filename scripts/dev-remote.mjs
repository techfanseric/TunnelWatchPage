// dev-remote.mjs — 默认 dev server:本地起页面,但 /api/* 全部代理到线上部署
// 用途:开发/验收直接用"本地最新代码 + 线上真实数据",跳过 db:pull。
// 对比 wrangler remote bindings(实测 pages dev 下会挂 / INTERNAL_ERROR),
// 这个方案零配置、无 secret、稳定。
//
// ⚠️ 注意:写操作(POST /api/bills 等)会真的打到线上库,验收时别乱提交表单。
// ⚠️ /api 跑的是线上已部署的 Functions;改了 functions/ 代码要用
//    `npm run dev:local`(本地 D1,先 db:pull)验证。
//
// 用法: npm run dev   →  http://127.0.0.1:8788(PORT 环境变量可改端口)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const UPSTREAM = 'https://tunnelwatch.pages.dev';
const PORT = Number(process.env.PORT) || 8788;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function proxyApi(req, res) {
  const upstream = https.request(
    UPSTREAM + req.url,
    { method: req.method, headers: { ...req.headers, host: new URL(UPSTREAM).host } },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('上游请求失败: ' + e.message);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxyApi(req, res);

  // 静态文件:/ → index.html,防目录穿越
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev:remote 就绪 → http://127.0.0.1:${PORT}`);
  console.log(`静态: ${ROOT}(本地最新代码)`);
  console.log(`/api/* → ${UPSTREAM}(线上真实数据,写操作会落到线上库!)`);
});
