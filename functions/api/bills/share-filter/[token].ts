import type { PagesFunction } from '@cloudflare/workers-types';
import { BillRow, Env, EMPTY_FILTERS, buildFilterWhere, json, toSharedBill } from '../../_billing';

interface ShareRow {
  token: string;
  owner_id: string;
  filters_json: string;
  created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const token = String(context.params.token || '').trim();
  if (!/^[a-f0-9]{32}$/.test(token)) return json({ error: 'invalid share token' }, 400);
  const row = await context.env.DB.prepare(
    `SELECT token, owner_id, filters_json, created_at FROM bill_share_filters WHERE token = ?`
  ).bind(token).first<ShareRow>();
  if (!row) return json({ error: 'share link not found' }, 404);
  let filters;
  try { filters = JSON.parse(row.filters_json); }
  catch { filters = EMPTY_FILTERS; }
  const { sql, binds } = buildFilterWhere(row.owner_id, filters);
  const result = await context.env.DB.prepare(
    `SELECT * FROM bills WHERE ${sql} ORDER BY paid_on DESC, id DESC LIMIT 500`
  ).bind(...binds).all<BillRow>();
  return json({
    token: row.token,
    filters,
    createdAt: row.created_at,
    bills: (result.results || []).map((r) => toSharedBill(r, context.request.url)),
  });
};
