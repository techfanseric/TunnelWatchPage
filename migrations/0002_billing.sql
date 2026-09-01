-- TunnelWatch D1 schema (v2): cloud billing ledger
-- Amounts are stored as integer RMB fen. An unlimited bill has unlimited = 1
-- and expires_on = NULL. owner_id is deliberately explicit for future accounts.

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL DEFAULT 'personal',
  created_by_device TEXT NOT NULL,
  subscription_key TEXT NOT NULL DEFAULT '',
  subscription_name TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('purchase', 'renewal')),
  amount_fen INTEGER NOT NULL CHECK(amount_fen >= 0),
  payer TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  expires_on TEXT,
  unlimited INTEGER NOT NULL DEFAULT 0 CHECK(unlimited IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  share_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by_device) REFERENCES devices(uuid)
);

CREATE INDEX IF NOT EXISTS idx_bills_owner_paid
  ON bills(owner_id, paid_on DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_bills_subscription
  ON bills(owner_id, subscription_key, paid_on DESC);

