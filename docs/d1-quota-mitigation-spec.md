# D1 Read Quota 满 应急方案

> 给 worker D / E 共用。所有字段名、TTL、行为以本文件为准。

## 背景

Cloudflare D1 Free tier 限制 5M reads/day。这次会话测试 + 装机 + sync 拉得
太多,**今天 D1 read quota 满了**,任何走 D1 读的操作都返:

```
D1_ERROR: Your account has exceeded D1's free tier daily row read limit.
Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.
```

影响:
- `/api/bills` GET → 500 → App 报"账本读取失败"
- `/api/latest` / `/api/history` / `/api/devices` → 500 → Page 端图表也坏
- Agent 上传 ingest → 500 → last_upload 失败
- 静默时段功能在 quota 满期间也无法 PUT 改时段

## 方案目标(用户要求"方案稳定就行")

**三件套**,从最稳到最稳:

### 1. App 端:BillingRepository 本地缓存兜底

- `list(context)` 失败时,先打云端。云端 5xx 返回 last-known 缓存(`tw_bills_cache` SharedPreferences)
- 缓存写入时机:成功时同步覆盖本地
- UI 层(MainActivity)检测到用了缓存数据时,显示"显示离线数据 · YYYY-MM-DD HH:mm"
- 同时给用户一个明确的提示:云端 D1 配额已满,UTC 0:00 重置

### 2. Worker 端:模块级 in-memory cache

- `_cache.ts` 加 `Map<string, { value: any; expiresAt: number }>`,TTL 30s(默认),可被各 endpoint 调
- 包装函数 `cachedD1(key, ttlMs, fn)`:查 cache first,miss 调 fn,结果存 cache
- 所有 GET endpoint 走 `cachedD1`:
  - `/api/devices` 30s(设备列表变化少)
  - `/api/latest` 30s(高 QPS path — 1 个 device 30s 一次)
  - `/api/history` 60s(更重 query)
  - `/api/bills` 30s
- in-memory cache 在 Worker 单 instance 生命周期内有效,跨请求复用
- **不**替代边缘缓存(Workers Cache API),只是叠加一层更快的 in-memory

### 3. 友好错误:D1 quota message 识别

- App + Page 两端,看到 `D1_ERROR: ...exceeded D1's free tier daily row read limit...` 时,转成中文提示:
  - App: "云端 D1 配额已满,预计 UTC 0:00 自动重置,当前展示离线缓存"
  - Page: footer 显示"云端配额已满,数据为离线缓存 · 自动重试中"

## 不做(避免过度工程)

- 不接 KV、不换数据源
- 不做 retry with backoff(quota 满重试也是失败)
- 不做 UI 重构
- 不动 agent ingest 路径(quota 满时本应停止上传,这就是静默时段的设计初衷)
- 不动前端图表布局

## 验收标准

### Worker E

- [ ] `_cache.ts` 加 in-memory Map + `cachedD1(key, ttlMs, fn)`
- [ ] 4 个 GET endpoint 走 `cachedD1`:
  - `devices.ts` GET:30s
  - `latest.ts` GET:30s
  - `history.ts` GET:60s
  - `bills.ts` GET:30s
- [ ] in-memory cache 在同一 worker instance 内复用(curl × 2 同一秒,第二次命中 cache)
- [ ] 现有边缘 cache (`_cache.ts` 的 `matchEdgeCache` / `storeEdgeCache`) 保留并叠加
- [ ] 鉴权 / 校验 / 写路径未动
- [ ] `wrangler pages dev` 本地起服务,`curl /api/bills` 仍然 200(在 D1 没满的情况下);`/api/devices` 同

### Worker D (Android)

- [ ] `BillingRepository.list(context)` 失败时回退到 `tw_bills_cache` SharedPreferences
- [ ] 成功时同步覆盖本地 cache
- [ ] `listPayers(context)` 同样模式
- [ ] 错误 message 检测 `exceeded D1's free tier daily row read limit` → 转中文"云端 D1 配额已满,预计 UTC 0:00 自动重置,当前展示离线缓存 · YYYY-MM-DD HH:mm"
- [ ] 不破坏现有的 bills 增删改流程(create / delete / share-filter)
- [ ] MainActivity / BillingEditorActivity 显示本地 cache 时,UI 加 "📡 离线缓存" 标识
- [ ] `./gradlew :app:assembleDebug` 通过
- [ ] `./gradlew :app:testDebugUnitTest` 通过(如果加新测试的话)

## 责任边界

- Worker D 改 `TunnelWatch/app/src/main/java/tech/tunnelwatch/app/data/BillingRepository.kt` + `MainActivity.kt` (最小化 UI 改动)
- Worker E 改 `TunnelWatchPage/functions/api/_cache.ts` + 4 个 GET endpoint
- 互不重叠
- 主 agent(Mavis)负责:
  1. 把 spec 同步给两边
  2. 各自验收
  3. wrangler pages deploy + APK install
  4. 端到端验证(明天 8:00 AM CST 后 + 现在)

## Out of scope(留给用户)

- 升级 Cloudflare D1 到 paid plan(根上解决,需要绑卡)
- 接 Cloudflare KV 镜像 devices 表
- UI 大改版
