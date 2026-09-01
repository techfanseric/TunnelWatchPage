# TunnelWatchPage — Agent Working Guide

> 这是给 agent(包括 Mavis 自己、未来接手的人)的工作手册。设计/品牌/用户上下文看 `.impeccable.md`。

## 项目是什么

TunnelWatch 的可视化端,Cloudflare Pages + D1 部署。Agent 端(Android,不在此 repo)上传订阅源快照,这里渲染账单、节点健康度、续费建议、世界地图、流量曲线。

- 设备维度数据:`devices` / `snapshots` 表,1 对多
- 账单维度数据:`bills` / `bill_share_filters` 表,按 owner 隔离(预留多用户)
- 视图层:Vanilla JS + Chart.js,无框架,单页 `public/`

## 关键约定

### 🚨 1. 本地预览必须用真实数据

**`npm run db:seed` 是反模式,不是入口。** 它生成的假数据(momo-A/B、big-A/B、stl-A/B、确定性失败序列)只能验证 happy path,看不到真实 OnePlus 设备的渲染/性能/边界问题。

正确流程:
1. 改完 UI / 改完数据查询 / 改完图渲染逻辑
2. `npm run db:pull` 拉远程 D1 真数据到本地
3. `npm run dev` 起本地服务
4. 截图 / 浏览器自测 / Playwright 跑回归

`db:seed` 只在**离线 / 无 wrangler 远程权限 / 给截图补点数据**时用,且要在 PR/commit message 里说明。

### 2. 订阅源连通性 / 失败节点数只有时间趋势

两张图都是 X=时间的折线图,没有"最新快照"切换。**最新快照(X=订阅源的堆叠柱状图)没意义**:
- 一张快照看不出"变化"或"趋势",暴露不了真实问题
- 节点健康度直接看 `chart-sub-ok-rate` 更准
- 一眼数得清 6 个 sub 的 OK 数,不需要堆叠

如果未来要恢复 snapshot,要先在 AGENTS.md / PR 里证明它能带来"快照"这个时间维度看不出的信息维度,否则不要加回去。

### 3. (已合并到 2)

原"堆叠柱状图布局对称"约定随 snapshot 删除而废止,不再适用。

## 命令速查

```bash
npm install
npm run db:init && npm run db:migrate:billing && npm run db:migrate:filter-share  # 首次
npm run db:pull          # 每次开发前:拉远程 D1 → 本地 D1
npm run dev              # wrangler pages dev 127.0.0.1:8788
node shoot.mjs URL OUT [WIDTH] [24h|7d|30d] [true|false] [TIMEOUT] [HEIGHT]  # Playwright 截图
npm run db:query "SELECT 1"  # 查本地 D1
```

## 架构

- `public/app.js` — 主视图层(单文件 ~1900 行,按功能分段)
- `public/index.html` + `style.css` — UI 骨架 + 样式
- `migrations/000X_*.sql` — D1 schema 演进(已部署,不要破坏)
- `functions/` — Cloudflare Pages Functions(API 入口,`/api/devices` 等)
- `scripts/pull-remote.mjs` — 拉真数据(新,见上)
- `scripts/seed.mjs` — **deprecated**,仅离线兜底
- `wrangler.toml` — D1 binding(`database_id` 是远程实例;本地 dev 自动用 `.wrangler/state/v3/d1/`)

## 性能 / 数据约束

- 24h 视角:bucketed by 5min,100ms 内出图
- 7d 视角:bucketed by 30min
- 30d 视角:bucketed by 2h
- 单设备 snapshots 可能上千行;前端按 `kind` 优先级 full > probe,按 ts 倒序,只取时间窗内

## 不要做

- 不要加框架(React/Vue 等) — 当前 Vanilla JS 故意保持简单
- 不要把 `database_id` 换掉或新增 binding — 会断远程 D1 引用
- 不要回退 `VIEW_STORAGE_KEY` 到 v1 — 用户的"默认 trend"会失效
- 不要新增 mock / 假数据函数 — 直接用 db:pull
