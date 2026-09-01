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

App 默认 `tw.telemetry.url` 为空(不上传)。要让它打到本地 dev:

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

## 部署到 page.dev

把 `functions/api/ingest` 暴露到公网,让 App 不再依赖 `adb reverse`,实现"不碰手机"也能静默上传。

### 0. 前置

- Cloudflare 账号(免费层即可,D1 + Pages 都含)
- `cd ~/TunnelWatchPage && npm install` 装好 wrangler

### 1. 登录 + 创建远程 D1

```bash
# 1.1 登录
npx wrangler login
# 浏览器跳出来授权

# 1.2 建远程 D1(会输出 database_id)
npx wrangler d1 create tunnelwatch
# 把输出的 database_id 复制下来,填进 wrangler.toml:
#   [[d1_databases]]
#   binding = "DB"
#   database_name = "tunnelwatch"
#   database_id = "xxxx-xxxx-xxxx-xxxx"

# 1.3 在远程 D1 跑 schema
npx wrangler d1 execute tunnelwatch --remote --file=migrations/0001_init.sql
```

### 2. 部署 Pages

```bash
npx wrangler pages deploy public --project-name=tunnelwatch
# 部署成功后输出:
# ✨ Deployment complete! Take a peek over at https://<random-hash>.tunnelwatch.pages.dev
```

> 第一次部署前 `wrangler` 可能要求在 Cloudflare Dashboard 创建 Pages project,
> 或者直接用 `wrangler pages project create tunnelwatch` 提前建。

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
  "INSERT INTO devices (uuid, name) VALUES ('<uuid>', '<设备名如 OnePlus PHK110>')"

# 3.3 验证
npx wrangler d1 execute tunnelwatch --remote --command "SELECT * FROM devices"
```

### 4. App 端切到公网 URL

```bash
# 编辑 ~/TunnelWatch/local.properties
# 把:
#   tw.telemetry.url=http://localhost:8788
# 改成:
tw.telemetry.url=https://<your-project>.pages.dev
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
- 公网 `GET https://<your-project>.pages.dev/api/devices` 返回 JSON 白名单

### 部署后的工作模式

| 触发源 | 周期 | 是否需要 USB 连 Mac? |
|---|---|---|
| Widget onUpdate | 系统 30min | ❌ |
| WorkManager `LineProbeWorker` | 15min(best-effort) | ❌ |
| 打开 App / 点 widget | 用户行为 | ❌ |

**只要手机能上网 + widget 已加到桌面,30min 一次的 PROBE 就能自动喂饱 page.dev。**
本地 dev 模式(localhost:8788 + adb reverse)只在 Mac 直连调试时使用。

### 重新发布(改了 `functions/` 或 `public/` 后)

```bash
cd ~/TunnelWatchPage
npx wrangler pages deploy public --project-name=tunnelwatch
# 几十秒完成,公网 URL 不会变
```

## License

[MIT](./LICENSE) — 详见 LICENSE 文件。
