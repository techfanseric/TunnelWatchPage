export interface Env {
  DB: D1Database;
}

export interface BillRow {
  id: number;
  owner_id: string;
  created_by_device: string;
  subscription_key: string;
  subscription_name: string;
  entry_type: 'purchase' | 'renewal';
  amount_fen: number;
  payer: string;
  paid_on: string;
  starts_on: string;
  expires_on: string | null;
  unlimited: number;
  note: string;
  share_token: string;
  created_at: string;
  updated_at: string;
}

export type BillInput = {
  subscriptionKey?: unknown;
  subscriptionName?: unknown;
  entryType?: unknown;
  amountFen?: unknown;
  payer?: unknown;
  paidOn?: unknown;
  startsOn?: unknown;
  expiresOn?: unknown;
  unlimited?: unknown;
  note?: unknown;
};

export const PERSONAL_OWNER = 'personal';

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function requireDevice(request: Request, env: Env): Promise<string | Response> {
  const uuid = request.headers.get('X-Device-Uuid')?.trim();
  if (!uuid) return json({ error: 'missing X-Device-Uuid header' }, 401);
  const device = await env.DB.prepare('SELECT uuid FROM devices WHERE uuid = ?')
    .bind(uuid)
    .first<{ uuid: string }>();
  return device ? uuid : json({ error: 'device not authorized' }, 403);
}

export function parseBillInput(body: BillInput): { value?: {
  subscriptionKey: string;
  subscriptionName: string;
  entryType: 'purchase' | 'renewal';
  amountFen: number;
  payer: string;
  paidOn: string;
  startsOn: string;
  expiresOn: string | null;
  unlimited: number;
  note: string;
}; error?: Response } {
  const text = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const subscriptionName = text(body.subscriptionName, 120);
  const subscriptionKey = text(body.subscriptionKey, 512);
  const payer = text(body.payer, 80);
  const note = text(body.note, 500);
  const entryType = body.entryType === 'purchase' ? 'purchase' : body.entryType === 'renewal' ? 'renewal' : null;
  const amountFen = typeof body.amountFen === 'number' && Number.isInteger(body.amountFen) ? body.amountFen : -1;
  const paidOn = parseDate(body.paidOn);
  const startsOn = parseDate(body.startsOn);
  const unlimited = body.unlimited === true || body.unlimited === 1 ? 1 : 0;
  const expiresOn = unlimited ? null : parseDate(body.expiresOn);

  if (!subscriptionName) return { error: json({ error: 'subscriptionName required' }, 400) };
  if (!entryType) return { error: json({ error: 'entryType must be purchase or renewal' }, 400) };
  if (amountFen < 0 || amountFen > 100_000_000) return { error: json({ error: 'amountFen invalid' }, 400) };
  if (!payer) return { error: json({ error: 'payer required' }, 400) };
  if (!paidOn || !startsOn) return { error: json({ error: 'paidOn and startsOn must be YYYY-MM-DD' }, 400) };
  if (!unlimited && !expiresOn) return { error: json({ error: 'expiresOn required for a finite period' }, 400) };
  if (expiresOn && expiresOn < startsOn) return { error: json({ error: 'expiresOn must not precede startsOn' }, 400) };

  return { value: { subscriptionKey, subscriptionName, entryType, amountFen, payer, paidOn, startsOn, expiresOn, unlimited, note } };
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export function toBill(row: BillRow, requestUrl: string) {
  const origin = new URL(requestUrl).origin;
  return {
    id: row.id,
    ownerId: row.owner_id,
    createdByDevice: row.created_by_device,
    subscriptionKey: row.subscription_key,
    subscriptionName: row.subscription_name,
    entryType: row.entry_type,
    amountFen: row.amount_fen,
    currency: 'CNY',
    payer: row.payer,
    paidOn: row.paid_on,
    startsOn: row.starts_on,
    expiresOn: row.expires_on,
    unlimited: row.unlimited === 1,
    note: row.note,
    shareToken: row.share_token,
    shareUrl: `${origin}/?bill=${encodeURIComponent(row.share_token)}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSharedBill(row: BillRow, requestUrl: string) {
  const bill = toBill(row, requestUrl);
  return {
    id: bill.id,
    subscriptionName: bill.subscriptionName,
    entryType: bill.entryType,
    amountFen: bill.amountFen,
    currency: bill.currency,
    payer: bill.payer,
    paidOn: bill.paidOn,
    startsOn: bill.startsOn,
    expiresOn: bill.expiresOn,
    unlimited: bill.unlimited,
    note: bill.note,
    createdAt: bill.createdAt,
  };
}
