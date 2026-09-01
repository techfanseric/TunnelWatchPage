-- TunnelWatch D1 schema (v3): 账单筛选分享链接
-- bill_share_filters 持久化一组筛选条件(支付时间范围 + 支付人列表),
-- 由前端 POST /api/bills/share-filter 创建,GET /api/bills/share-filter/:token 只读返回匹配票据。
-- 票据数据本身仍然在 bills 表;这里只存"如何筛选",不复制数据。
-- owner_id 仍用显式 'personal',为后续多用户预留。

CREATE TABLE IF NOT EXISTS bill_share_filters (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'personal',
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bill_share_filters_owner
  ON bill_share_filters(owner_id, created_at DESC);
