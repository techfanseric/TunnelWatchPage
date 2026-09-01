-- TunnelWatch D1 schema (v1)
-- 两张表:
--   devices   - 设备白名单,App 上传时鉴权用
--   snapshots - 时序数据,FULL / PROBE 两类,15min 窗口去重
--
-- 本地 dev 用: wrangler d1 execute tunnelwatch --local --file=migrations/0001_init.sql
-- 部署到 page.dev: wrangler d1 execute tunnelwatch --remote --file=migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS devices (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_uuid TEXT NOT NULL,
  device_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('full', 'probe')),
  ts INTEGER NOT NULL,                 -- unix ms
  summary_json TEXT NOT NULL,          -- 小,卡片用
  payload_json TEXT NOT NULL,          -- 大,完整 ProxyStatus
  FOREIGN KEY (device_uuid) REFERENCES devices(uuid)
);

-- 时序查询主索引
CREATE INDEX IF NOT EXISTS idx_dev_kind_ts
  ON snapshots(device_uuid, kind, ts DESC);

-- 全设备最新一条(前端默认设备选择用)
CREATE INDEX IF NOT EXISTS idx_kind_ts
  ON snapshots(kind, ts DESC);

-- 设备维度总览
CREATE INDEX IF NOT EXISTS idx_dev_ts
  ON snapshots(device_uuid, ts DESC);
