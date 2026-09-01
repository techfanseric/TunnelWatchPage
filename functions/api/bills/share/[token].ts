import type { PagesFunction } from '@cloudflare/workers-types';
import { BillRow, Env, json, toSharedBill } from '../../_billing';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const token = String(context.params.token || '').trim();
  if (!/^[a-f0-9]{32}$/.test(token)) return json({ error: 'invalid share token' }, 400);
  const row = await context.env.DB.prepare('SELECT * FROM bills WHERE share_token = ?')
    .bind(token).first<BillRow>();
  return row ? json({ bill: toSharedBill(row, context.request.url) }) : json({ error: 'bill not found' }, 404);
};
