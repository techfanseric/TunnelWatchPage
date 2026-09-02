-- TunnelWatch D1 schema (v4): quiet hours — agent skip cloud upload in [start, end)
-- 两列加在 devices 表上;start/end 是分钟数 0..1439
--   start == end → 禁用静默,全时段照常上传
--   start <  end → 同一天窗口,如 0..480 = 00:00-08:00
--   start >  end → 跨午夜窗口,如 1320..360 = 22:00-次日 06:00
-- 默认值与 §2 一致:0/480。已有行靠 DEFAULT 自动填,不需要 backfill。
ALTER TABLE devices ADD COLUMN quiet_hour_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN quiet_hour_end   INTEGER NOT NULL DEFAULT 480;
