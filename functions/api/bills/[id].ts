import type { PagesFunction } from '@cloudflare/workers-types';
import { BillInput, BillRow, Env, PERSONAL_OWNER, json, parseBillInput, requireDevice, toBill } from '../_billing';

function billId(value: string | string[] | undefined): number | null {
  const id = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const device = await requireDevice(context.request, context.env);
  if (device instanceof Response) return device;
  const id = billId(context.params.id);
  if (!id) return json({ error: 'invalid bill id' }, 400);
  let body: BillInput;
  try { body = await context.request.json<BillInput>(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }
  const parsed = parseBillInput(body);
  if (!parsed.value) return parsed.error!;
  const b = parsed.value;
  const result = await context.env.DB.prepare(
    `UPDATE bills SET subscription_key = ?, subscription_name = ?, entry_type = ?,
      amount_fen = ?, payer = ?, paid_on = ?, starts_on = ?, expires_on = ?,
      unlimited = ?, note = ?, updated_at = datetime('now')
     WHERE id = ? AND owner_id = ?`
  ).bind(
    b.subscriptionKey, b.subscriptionName, b.entryType, b.amountFen, b.payer,
    b.paidOn, b.startsOn, b.expiresOn, b.unlimited, b.note, id, PERSONAL_OWNER
  ).run();
  if (!result.meta.changes) return json({ error: 'bill not found' }, 404);
  const row = await context.env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first<BillRow>();
  return json({ bill: toBill(row!, context.request.url) });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const device = await requireDevice(context.request, context.env);
  if (device instanceof Response) return device;
  const id = billId(context.params.id);
  if (!id) return json({ error: 'invalid bill id' }, 400);
  const result = await context.env.DB.prepare('DELETE FROM bills WHERE id = ? AND owner_id = ?')
    .bind(id, PERSONAL_OWNER).run();
  return result.meta.changes ? json({ ok: true }) : json({ error: 'bill not found' }, 404);
};

