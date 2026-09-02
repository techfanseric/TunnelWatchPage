# Quiet Hours — 静默时段功能规格

> 给 worker A/B/C 共用的契约文档。任何字段名/路径/状态码/默认值,以此文件为准。

## 1. 业务目标

Cloudflare Pages 免费额度有限,Android Agent 后台 15min 周期上传浪费流量。
加"静默时段":在 [start, end) 窗口内,所有云端上传全部跳过(本地采集测活**继续**,widget 照常刷新)。

## 2. 默认值

- `quietHourStart = 0`  (00:00)
- `quietHourEnd   = 480` (08:00)
- 用户在两端可改,云端 D1 同步。

## 3. 数据模型

`devices` 表新增 2 列(migration `0004_quiet_hours.sql`):

```sql
ALTER TABLE devices ADD COLUMN quiet_hour_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN quiet_hour_end   INTEGER NOT NULL DEFAULT 480;
```

字段语义:
- `quiet_hour_start` / `quiet_hour_end`:分钟数,0..1439(00:00..23:59)
- `start == end`:**禁用**静默,全时段照常上传
- `start < end`:同一天内,如 0..480 = 00:00-08:00
- `start > end`:跨午夜,如 1320..360 = 22:00-次日 06:00

**不要破坏**已有 `devices` / `snapshots` / `bills` / `bill_share_filters` 任何表。

## 4. API 契约(权威)

### 4.1 GET /api/devices  (扩展已有)

响应新增两个字段(对每个 device):

```json
{
  "devices": [
    {
      "uuid": "...",
      "name": "...",
      "createdAt": "...",
      "lastSeenAt": 1234567890,
      "quietHourStart": 0,
      "quietHourEnd": 480
    }
  ]
}
```

### 4.2 PUT /api/devices/:uuid  (新)

**Path**: `/api/devices/{uuid}`  
**Method**: `PUT`  
**Auth header**: `X-Device-Uuid: <uuid>` 必须等于 path 里的 `:uuid`(`requireDevice` helper 见 `_billing.ts:98`)  
**Content-Type**: `application/json`

Request body:
```json
{
  "quietHourStart": 0,
  "quietHourEnd": 480
}
```

校验:
- `quietHourStart` / `quietHourEnd` 必须是 integer,0..1439
- 不存在则 400 `{error: "..."}`
- 通过则更新 `devices.quiet_hour_start` / `devices.quiet_hour_end`
- 不允许改 `name`(只允许改静默时段;若 body 带 name 字段,忽略或 400 — worker A 自己选,推荐 400)

Response 200:
```json
{
  "uuid": "...",
  "name": "...",
  "quietHourStart": 0,
  "quietHourEnd": 480,
  "updatedAt": "2026-09-02T08:30:00Z"
}
```

错误码:
- 401 `missing X-Device-Uuid header`
- 403 `device not authorized`
- 400 `quietHourStart must be integer 0-1439` / `quietHourEnd must be integer 0-1439` / `name is not editable`

### 4.3 缓存语义

`GET /api/devices` 仍走 `_cache.ts` 现有 600s 边缘缓存。`PUT` 成功后下次 GET 在缓存窗口内可能仍是旧值。
**用户视角**:Page 端 PUT 后,自己前端 state 立刻更新(乐观更新),不强等 GET 命中;Agent 端下次同步周期(见 §6)重新读到即可。

## 5. Page UI 规格(worker B 负责)

### 5.1 位置

- 在现有 `.device-picker` 旁边加一个图标按钮 `<button id="device-settings-btn" aria-label="静默时段设置">⚙</button>`
- 点击弹出 popover/modal(`<dialog>` 或自己定位的 div,选最简单的)

### 5.2 弹层内容

```
┌─ 不更新时段 ────────────────┐
│ 设备: <当前 device name>     │
│                              │
│ 起始时间  [HH:MM] (24h)      │
│ 结束时间  [HH:MM] (24h)      │
│                              │
│ [重置默认 00:00-08:00]       │
│ [保存]                       │
│                              │
│ 说明:                        │
│ 静默期内,Agent 本地测活继续,│
│ widget 正常显示,但云端不上传。│
│ 起始≥结束(如 22:00-06:00)跨午夜。│
└──────────────────────────────┘
```

- 时间 input 用 `<input type="time">`,5min 步进(`step="300"`)
- 保存按钮:发 `PUT /api/devices/{currentDevice}`,成功后关弹层 + 刷新当前 device 在 state 里的记录 + `setFooter` 一行成功提示
- 失败:弹层不关,显示 error
- 重置默认:把两个 input 填回 00:00 / 08:00,**不自动保存**

### 5.3 设备名下的小角标

在 `.device-picker` 旁(或 device name option 的 label 里)显示当前静默窗口,例如:

```
设备: [OnePlus PHK110 ▾]   🌙 00:00-08:00
```

- 当 `start == end` 时不显示角标
- 角标用现有 meta 灰字 style,不加新色

### 5.4 Footer 状态

在现有 `setFooter` 的位置,新增一个**不影响现有 footer**的辅助行(放 footer 下面或里面,自己选):

- 当 `now` 落在当前选中设备的静默窗口内时,显示一行:
  `🌙 静默时段中(00:00-08:00),Agent 本地测活正常,云端暂停上报。`
- 颜色用现有 meta 灰字,不加新色
- 用 `setInterval(60_000, ...)` 每分钟检查一次是否仍在窗口

### 5.5 APP_VERSION

发版前**必须**改 `public/app.js` 顶部 `APP_VERSION` 为 `YYYY.MM.DD-HHmm`,沿用现有风格。
参考 `AGENTS.md` §4。

## 6. Android 端规格(worker C 负责)

### 6.1 新文件: `data/TelemetrySettings.kt`

```kotlin
package tech.tunnelwatch.app.data

import android.content.Context
import java.util.Calendar

/**
 * 静默时段设置 — 单一来源在云端 D1,本地 SharedPreferences 缓存加速。
 *
 * 默认值 0..480(00:00-08:00)。
 * 同步触发:
 *  - App 启动时(TunnelWatchApp.onCreate)
 *  - Worker 周期顶部(LineProbeWorker.doWork 头部)
 *  - 用户在 TelemetryActivity 编辑后(立即)
 */
object TelemetrySettings {
    private const val PREF = "tw_quiet_hours"
    private const val KEY_START = "quiet_hour_start"
    private const val KEY_END = "quiet_hour_end"
    const val DEFAULT_START = 0
    const val DEFAULT_END = 480

    data class Window(val startMinute: Int, val endMinute: Int) {
        fun isEnabled(): Boolean = startMinute != endMinute
    }

    fun load(context: Context): Window {
        val sp = context.applicationContext
            .getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val s = sp.getInt(KEY_START, DEFAULT_START)
        val e = sp.getInt(KEY_END, DEFAULT_END)
        return Window(s, e)
    }

    fun save(context: Context, startMinute: Int, endMinute: Int) {
        require(startMinute in 0..1439) { "startMinute out of range" }
        require(endMinute in 0..1439) { "endMinute out of range" }
        context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit()
            .putInt(KEY_START, startMinute)
            .putInt(KEY_END, endMinute)
            .apply()
    }

    /**
     * 当前设备本地时间是否落在 [start, end) 窗口内。
     * start == end → 始终返回 false(禁用)。
     * start > end  → 跨午夜(now >= start || now < end)。
     */
    fun isInQuietHours(window: Window, now: Calendar = Calendar.getInstance()): Boolean {
        if (!window.isEnabled()) return false
        val minute = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        return if (window.startMinute < window.endMinute) {
            minute in window.startMinute until window.endMinute
        } else {
            minute >= window.startMinute || minute < window.endMinute
        }
    }

    fun isInQuietHours(context: Context): Boolean = isInQuietHours(load(context))
}
```

### 6.2 改 `data/TelemetryPublisher.kt`

在 `report()` 方法的最开始(URL 空检查之后,throttle 之前),加一段:

```kotlin
val window = TelemetrySettings.load(appCtx)
if (TelemetrySettings.isInQuietHours(window)) {
    val now = System.currentTimeMillis()
    AppLog.d(TAG, "skipped kind=$kind (in quiet hours ${window.startMinute}-${window.endMinute})")
    DeviceIdentity.setLastUpload(appCtx, now, false, "skipped: quiet hours")
    return
}
```

注意:
- `lastSentAt` 不要更新(静默跳过不计入 throttle 时间窗 — 避免静默期间用户点击全被 throttle)
- 保持 5 处调用点的语义完全不变;只看 kind / status,不再传 `force` 参数
- 静默命中时只 log + 更新 `lastUpload` 元数据

### 6.3 新建 `data/TelemetrySettingsSync.kt`

从 `/api/devices` 拉取,找自己 uuid,更新本地 SharedPreferences。

```kotlin
package tech.tunnelwatch.app.data

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import tech.tunnelwatch.app.util.AppLog

/**
 * 启动/周期顶部,把云端 /api/devices 的静默时段拉下来写本地 cache。
 * 失败静默(用本地旧值) — 静默时段是 best-effort,不能因为拉不到就把人凌晨 4 点吵醒。
 */
object TelemetrySettingsSync {
    private const val TAG = "TW/QHSync"
    // 复用 TelemetryPublisher 的 OkHttp client(私有,不能直接拿;
    //   新建一个 5s timeout 的小 client,反正这条请求很少发)
    private val http by lazy {
        OkHttpClient.Builder()
            .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
            .build()
    }

    /**
     * 拉一次,更新本地缓存。返回是否成功。
     * @param telemetryBaseUrl 来自 BuildConfig.TW_TELEMETRY_URL(同 TelemetryPublisher)
     * @param uuid             自己的设备 UUID
     */
    fun syncOnce(context: Context, telemetryBaseUrl: String, uuid: String): Boolean {
        val base = telemetryBaseUrl.trim().trimEnd('/')
        if (base.isEmpty() || uuid.isEmpty()) return false
        return try {
            val req = Request.Builder()
                .url("$base/api/devices")
                .header("X-Device-Uuid", uuid)
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    AppLog.w(TAG, "sync failed HTTP ${resp.code}")
                    return false
                }
                val body = resp.body?.string().orEmpty()
                val root = JSONObject(body)
                val arr = root.optJSONArray("devices") ?: return false
                for (i in 0 until arr.length()) {
                    val d = arr.getJSONObject(i)
                    if (d.optString("uuid") == uuid) {
                        val s = d.optInt("quietHourStart", TelemetrySettings.DEFAULT_START)
                        val e = d.optInt("quietHourEnd", TelemetrySettings.DEFAULT_END)
                        if (s in 0..1439 && e in 0..1439) {
                            TelemetrySettings.save(context, s, e)
                            AppLog.d(TAG, "synced window $s..$e from cloud")
                            return true
                        }
                    }
                }
                false
            }
        } catch (e: Throwable) {
            AppLog.w(TAG, "sync exception: ${e.javaClass.simpleName} ${e.message}")
            false
        }
    }
}
```

调用点:
- `TunnelWatchApp.onCreate`(冷启动)
- `LineProbeWorker.doWork()` 头部(每次 15min 周期开头)
- 用户在 `TelemetryActivity` 点击"立即同步"按钮(可选 UX)

### 6.4 扩展 `TelemetryActivity` + `activity_telemetry.xml`

在现有"设备名"区下方加一块:

```
不更新时段
  起始  [00:00] [选]      ← 点击 [选] 弹 TimePickerDialog(24h 模式)
  结束  [08:00] [选]
  [保存到云端]  [恢复默认 00:00-08:00]
  当前状态:🌙 静默中 / ✓ 正常上传
```

- 选时按钮:走 `TimePickerDialog`,24h,5min 步进
- "保存到云端":发 `PUT /api/devices/{uuid}`(请求构造可以参考现有 OkHttp 用法),成功后写本地 SharedPreferences
- "恢复默认":把 input 改回 0/480,**不自动保存**
- "当前状态":每分钟重算一次,显示 `🌙 当前在静默时段(00:00-08:00)` 或 `✓ 当前不在静默时段`
- 顶部调用 `TelemetrySettingsSync.syncOnce(...)` 一次(onResume),保证看到的总是最新云端值

### 6.5 构建产物

```bash
cd ~/TunnelWatch
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
./gradlew :app:assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
# **不要**自动 install — 由主 agent 验收时手动 install(防 ColorOS -99 反复触发)
```

## 7. 验收清单

worker A (TunnelWatchPage 后端):
- [ ] `migrations/0004_quiet_hours.sql` 文件存在,语法可被 `wrangler d1 execute` 接受
- [ ] `npm run db:init && npm run db:migrate:billing && npm run db:migrate:filter-share && npm run db:migrate:quiet-hours` 跑通(需要把新 migration 加到 `package.json` scripts)
- [ ] `npm run db:pull && npm run db:reset` 后,本地 D1 `devices` 表有 2 个新列,默认值正确
- [ ] `GET /api/devices` 响应含 `quietHourStart` / `quietHourEnd`
- [ ] `PUT /api/devices/{uuid}` 鉴权 + 校验 + 更新均正常
- [ ] 错误路径(401 / 403 / 400)各自返回正确状态码和 message
- [ ] 已有 API(`/api/ingest`, `/api/bills/*`, `/api/history`, `/api/latest`)未被破坏

worker B (TunnelWatchPage 前端):
- [ ] 浏览器本地 dev 跑起来,topbar 多一个 ⚙ 按钮
- [ ] 点击 ⚙ 弹层打开,显示当前设备的静默时段
- [ ] 保存:API 200 + footer 成功 + 角标更新
- [ ] 跨午夜(22:00-06:00)可保存,后端校验不挡
- [ ] footer 指示行在静默窗口内出现,窗口外消失
- [ ] `APP_VERSION` 已 bump
- [ ] 浏览器 console 无 error,无 404

worker C (TunnelWatch Android):
- [ ] `TelemetrySettings` 单元自测:`isInQuietHours` 4 个 case(start<end / start>end / start==end disabled / 跨午夜)正确
- [ ] `TelemetryPublisher.report` 在静默窗口内被调用时,`AppLog.d` 输出 `skipped kind=... (in quiet hours ...)`,且 `lastSentAt` 不更新
- [ ] `TelemetrySettingsSync.syncOnce` 调通:打 mock JSON 进 OkHttp,可解出并写本地
- [ ] `TelemetryActivity` UI:TimePicker 弹出、24h 模式、保存成功
- [ ] `./gradlew :app:assembleDebug` 通过,APK 产物存在

## 8. 责任边界

- worker A 改 `TunnelWatchPage/` 内的后端文件
- worker B 改 `TunnelWatchPage/public/` 内的前端文件
- worker C 改 `TunnelWatch/app/src/main/` 内的 Android 文件
- 三个 worker 互不重叠,不需要互相等待
- 主 agent(Mavis)负责:
  1. 把 spec 同步给三方
  2. 各自验收
  3. 跑线上 deploy(`wrangler pages deploy` + `wrangler d1 execute ... --remote --file=migrations/0004_quiet_hours.sql` + Android APK install)
  4. 端到端验证:页面改 → D1 → Android 下次同步读到 → 下个 worker 周期跳过
