# TunnelWatch 状态面板

> TunnelWatch Android App 的遥测展示端 — Cloudflare Pages + D1 + Functions。

![Topics](https://img.shields.io/badge/cloudflare-pages-F38020?logo=cloudflare&logoColor=white)
![Topics](https://img.shields.io/badge/cloudflare-d1-F38020?logo=cloudflare&logoColor=white)
![Topics](https://img.shields.io/badge/cloudflare-functions-F38020?logo=cloudflare&logoColor=white)
![Topics](https://img.shields.io/badge/license-MIT-green)

## 预览

![Dashboard](./renewal-decision.png)

---

App 端:每次 widget 刷新(FULL 拉取 + PROBE 测活)把 `ProxyStatus` 上报到 `/api/ingest`;
服务端:写 D1,15 分钟窗口去重;
展示端:静态前端拉 `/api/devices` / `/api/latest` / `/api/history` 渲染卡片镜像 + 4 张 24h 趋势图。

## 本地开发

### 1. 装依赖 + 初始化 D1

```bash
cd ~/TunnelWatchPage
npm install                # 装 wrangler + types(本地 dev,不需要 Cloudflare 账号)
npm run db:init            # 在本地 D1 创建表(devices + snapshots)
npm run db:migrate:billing # 创建云端账单表(bills)
npm run db:seed            # 插入 24h 假数据 + 1 个授权设备(0x...0001 DevTestPhone)
```

### 2. 启动 dev server

```bash
npm run dev
# 启动后访问 http://localhost:8788
```

`wrangler pages dev` 同时提供:
- 静态文件 `public/`(HTML / CSS / JS)
- Pages Functions `functions/api/*`(TypeScript 实时编译)
- 本地 D1(`.wrangler/state/v3/d1/...` 下的 SQLite 文件)

修改 `functions/*.ts` 或 `public/*` 改完保存即生效(有 live reload)。

### 3. 让真机 App 上报到本地

App 默认上报到 `https://tunnelwatch.pages.dev`。要让它临时打到本地 dev，
可在 `local.properties` 覆盖生产默认值:

**a) 在 TunnelWatch 仓库配 URL**
```bash
# ~/TunnelWatch/local.properties
tw.telemetry.url=http://localhost:8788
```

**b) 把手机的 localhost 反向到 Mac**
```bash
adb reverse tcp:8788 tcp:8788
```

**c) 重建 + 装机 + 触发 widget 刷新**
```bash
cd ~/TunnelWatch && ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am force-stop tech.tunnelwatch.app
adb shell am start -n tech.tunnelwatch.app/.MainActivity
# 或者点 widget / App 内"刷新"按钮
```

**d) 验证**
```bash
# wrangler dev 控制台会显示 POST /api/ingest + 200 OK
# 或者查询:
npm run db:query -- "SELECT kind, datetime(ts/1000, 'unixepoch') as t, summary_json FROM snapshots ORDER BY ts DESC LIMIT 5"
```

## 目录结构

```
TunnelWatchPage/
├── wrangler.toml             # D1 binding + Pages 配置
├── package.json              # scripts: dev / db:init / db:seed / db:query / db:reset
├── tsconfig.json             # Pages Functions TS 配置
├── migrations/
│   └── 0001_init.sql         # devices + snapshots 表
├── functions/
│   └── api/
│       ├── ingest.ts         # POST,鉴权 + 15min dedup
│       ├── latest.ts         # GET,最新一条
│       ├── history.ts        # GET,24h 窗口内所有
│       └── devices.ts        # GET,授权设备列表
├── public/
│   ├── index.html            # 前端骨架
│   ├── style.css             # 极浅色 + 1dp 描边,跟 App 卡片风格一致
│   └── app.js                # 拉 API + 渲染 4 张图
└── scripts/
    └── seed.mjs              # 24h 假数据生成器
```

## API 契约

### POST /api/ingest

Header: `X-Device-Uuid: <uuid>`(必须在 `devices` 表里)

Body:
```json
{
  "kind": "full" | "probe",
  "ts": 1735689600000,
  "deviceUuid": "...",
  "deviceName": "OnePlus PHK110",
  "summary": { "online": true, "serverName": "...", "quotaUsedGB": 142.3, ... },
  "payload": { /* 完整 ProxyStatus JSON,跟 App 端 StatusCache.encodeFull 输出对齐 */ }
}
```

Response: `{ ok: true, id: <rowId>, dedupDeleted: <count> }`

### GET /api/devices

Response: `{ devices: [{ uuid, name, createdAt, lastSeenAt }, ...] }`

### GET /api/latest?device=<uuid>&kind=<full|probe>

Response: `{ id, device, deviceName, kind, ts, summary, payload }`

### GET /api/history?device=<uuid>&hours=<24>&kind=<full>

Response: `{ device, hours, kind, items: [{ id, ts, kind, summary }, ...] }`

### 账单 API

- `GET /api/bills`：列出个人云端账本，需要 `X-Device-Uuid`。
- `POST /api/bills`：新增一张“新增 / 续费”票据；金额使用人民币分，`unlimited=true` 时不传到期日。
- `PUT /api/bills/:id` / `DELETE /api/bills/:id`：修改或删除票据，需要已登记设备 UUID。
- `GET /api/bills/share/:token`：只返回可分享字段，不泄露设备 UUID、订阅 URL 或分享令牌。

账单首版使用显式 `owner_id=personal`，为后续多用户迁移保留所有权边界；当前写权限仍沿用设备白名单。

## 部署到 pages.dev

把 `functions/api/ingest` 暴露到公网,让 App 不再依赖 `adb reverse`,实现"不碰手机"也能静默上传。

### 当前生产环境

- Pages 项目:`tunnelwatch`
- 固定地址:`https://tunnelwatch.pages.dev`
- D1 数据库:`tunnelwatch`
- D1 ID:`0dc9db60-42fb-435c-921a-f5c3ec3bdefc`
- D1 binding:`DB`(配置见 `wrangler.toml`)
- 已登记设备:`OnePlus PHK110`

`wrangler pages deploy` 每次会另外输出一个带部署 hash 的预览地址；App 和文档应始终使用上面的固定生产地址。

### 0. 前置

- Cloudflare 账号(免费层即可,D1 + Pages 都含)
- `cd ~/TunnelWatchPage && npm install` 装好 wrangler

### 1. 登录 + 创建远程 D1(仅新环境)

```bash
# 1.1 登录
npx wrangler login
# 浏览器跳出来授权

# 1.2 建远程 D1(会输出 database_id)
npx wrangler d1 create tunnelwatch
# 把输出的 database_id 复制下来,填进 wrangler.toml。
# 当前生产环境已经配置完成,不要重复创建:
#   [[d1_databases]]
#   binding = "DB"
#   database_name = "tunnelwatch"
#   database_id = "0dc9db60-42fb-435c-921a-f5c3ec3bdefc"

# 1.3 在远程 D1 跑 schema
npx wrangler d1 execute tunnelwatch --remote --file=migrations/0001_init.sql
```

### 2. 部署 Pages

```bash
npx wrangler pages deploy public --project-name=tunnelwatch
# 部署成功后输出:
# ✨ Deployment complete! Take a peek over at https://<random-hash>.tunnelwatch.pages.dev
# 固定生产地址仍是 https://tunnelwatch.pages.dev
```

> 第一次部署前 `wrangler` 可能要求在 Cloudflare Dashboard 创建 Pages project,
> 或者直接用 `wrangler pages project create tunnelwatch` 提前建。

新增账单功能的现有环境还需要执行一次：

```bash
npx wrangler d1 execute tunnelwatch --remote --file=migrations/0002_billing.sql
```

### 3. 注册设备 UUID 到远程 D1

每台手机/平板的 UUID 必须在远程 `devices` 白名单里,`/api/ingest` 才会接收。

```bash
# 3.1 从手机读 UUID
ADB=/opt/homebrew/share/android-commandlinetools/platform-tools/adb
$ADB shell run-as tech.tunnelwatch.app cat shared_prefs/tw_device_identity.xml \
  | grep -oE '<string name="uuid">[^<]+' | sed 's/.*>//'
# 输出形如: 69af700e-0242-4d1a-acd6-9e9ff802f2bd

# 3.2 写入远程 D1
npx wrangler d1 execute tunnelwatch --remote --command \
  "INSERT INTO devices (uuid, name) VALUES ('<uuid>', '<设备名如 OnePlus PHK110>') ON CONFLICT(uuid) DO UPDATE SET name=excluded.name"

# 3.3 验证
npx wrangler d1 execute tunnelwatch --remote --command "SELECT * FROM devices"
```

### 4. App 端生产 URL

`~/TunnelWatch/app/build.gradle.kts` 已把生产地址设为代码级默认值；本机
`local.properties` 也应保持相同配置。只有联调本地 Functions 时才临时覆盖为 localhost。

```bash
# ~/TunnelWatch/local.properties
tw.telemetry.url=https://tunnelwatch.pages.dev
```

> 改完本地 dev 也可以继续用:wrangler `pages dev` 会在本地 8788 监听,
> 但 App 端这时打的是公网,要走公网回路。本地开发继续测的话**临时改回** `http://localhost:8788` + `adb reverse`。

### 5. 重新构建 + 装机 + 触发首次上传

```bash
cd ~/TunnelWatch
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
./gradlew :app:assembleDebug

$ADB install -r app/build/outputs/apk/debug/app-debug.apk
$ADB shell am force-stop tech.tunnelwatch.app
$ADB shell am start -n tech.tunnelwatch.app/.MainActivity
# 打开 App 等 5 秒(FULL 上传),或点 widget 触发(PROBE 上传)
```

### 6. 验证

- App 端 `tw_device_identity.xml` 应出现 `last_upload_ok=true` + `last_upload_detail=HTTP 200`
- 远程 D1 应有新行:
  ```bash
  npx wrangler d1 execute tunnelwatch --remote --command \
    "SELECT device_name, kind, ts FROM snapshots ORDER BY ts DESC LIMIT 4"
  ```
- 公网 `GET https://tunnelwatch.pages.dev/api/devices` 返回 JSON 白名单

### 部署后的工作模式

| 触发源 | 周期 | 是否需要 USB 连 Mac? |
|---|---|---|
| Widget onUpdate | 系统 30min | ❌ |
| WorkManager `LineProbeWorker` | 15min(best-effort) | ❌ |
| 打开 App / 点 widget | 用户行为 | ❌ |

**只要手机能上网 + widget 已加到桌面,30min 一次的 PROBE 就能自动喂饱 pages.dev。**
本地 dev 模式(localhost:8788 + adb reverse)只在 Mac 直连调试时使用。

### 日常重新发布

改了 `functions/` 或 `public/` 后按下面执行。现有 Pages 项目和 D1 都不要重建；只有新增 migration 时，才先对生产 D1 执行对应的新 SQL 文件。

```bash
cd ~/TunnelWatchPage

# 1. 部署前检查
npm install
git diff --check

# 2. 如有新 migration,先执行一次(没有就跳过)
# npx wrangler d1 execute tunnelwatch --remote --file=migrations/<new_migration>.sql

# 3. 发布静态文件和 Pages Functions
npx wrangler pages deploy public \
  --project-name=tunnelwatch \
  --branch=main \
  --commit-dirty=true

# 4. 验证固定生产地址、API 和生产 D1
curl -fsSI https://tunnelwatch.pages.dev/
curl -fsS https://tunnelwatch.pages.dev/api/devices
npx wrangler d1 execute tunnelwatch --remote --command \
  "SELECT device_name, kind, datetime(ts/1000, 'unixepoch') AS uploaded_at_utc FROM snapshots ORDER BY ts DESC LIMIT 5"
```

部署命令输出的 `https://<hash>.tunnelwatch.pages.dev` 是当次预览地址；对外地址和 App 配置仍保持 `https://tunnelwatch.pages.dev`。

## License

[MIT](./LICENSE) — 详见 LICENSE 文件。
