import type { PagesFunction } from '@cloudflare/workers-types';
import { BillInput, BillRow, Env, PERSONAL_OWNER, json, parseBillInput, requireDevice, toBill } from './_billing';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const device = await requireDevice(context.request, context.env);
  if (device instanceof Response) return device;
  const result = await context.env.DB.prepare(
    `SELECT * FROM bills WHERE owner_id = ? ORDER BY paid_on DESC, id DESC LIMIT 300`
  ).bind(PERSONAL_OWNER).all<BillRow>();
  return json({ bills: (result.results || []).map((row) => toBill(row, context.request.url)) });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const device = await requireDevice(context.request, context.env);
  if (device instanceof Response) return device;
  let body: BillInput;
  try { body = await context.request.json<BillInput>(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }
  const parsed = parseBillInput(body);
  if (!parsed.value) return parsed.error!;
  const b = parsed.value;
  const token = crypto.randomUUID().replaceAll('-', '');
  const inserted = await context.env.DB.prepare(
    `INSERT INTO bills (
      owner_id, created_by_device, subscription_key, subscription_name, entry_type,
      amount_fen, payer, paid_on, starts_on, expires_on, unlimited, note, share_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    PERSONAL_OWNER, device, b.subscriptionKey, b.subscriptionName, b.entryType,
    b.amountFen, b.payer, b.paidOn, b.startsOn, b.expiresOn, b.unlimited, b.note, token
  ).run();
  const row = await context.env.DB.prepare('SELECT * FROM bills WHERE id = ?')
    .bind(inserted.meta.last_row_id).first<BillRow>();
  return json({ bill: toBill(row!, context.request.url) }, 201);
};
