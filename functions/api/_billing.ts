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

export interface BillFilters {
  paidFrom: string | null;
  paidTo: string | null;
  payers: string[];
}

export const EMPTY_FILTERS: BillFilters = { paidFrom: null, paidTo: null, payers: [] };

export function parseFilters(body: unknown): { value?: BillFilters; error?: Response } {
  if (body == null) return { value: { ...EMPTY_FILTERS } };
  if (typeof body !== 'object') return { error: json({ error: 'filters must be an object' }, 400) };
  const src = body as Record<string, unknown>;
  const paidFrom = parseDate(src.paidFrom);
  if (src.paidFrom != null && src.paidFrom !== '' && paidFrom == null) {
    return { error: json({ error: 'paidFrom must be YYYY-MM-DD' }, 400) };
  }
  const paidTo = parseDate(src.paidTo);
  if (src.paidTo != null && src.paidTo !== '' && paidTo == null) {
    return { error: json({ error: 'paidTo must be YYYY-MM-DD' }, 400) };
  }
  if (paidFrom && paidTo && paidFrom > paidTo) {
    return { error: json({ error: 'paidFrom must not be after paidTo' }, 400) };
  }
  const rawPayers = Array.isArray(src.payers) ? src.payers : [];
  if (!rawPayers.every((p) => typeof p === 'string')) {
    return { error: json({ error: 'payers must be a string array' }, 400) };
  }
  const payers = Array.from(new Set(rawPayers.map((p) => p.trim()).filter((p) => p.length > 0).slice(0, 30))).slice(0, 30);
  if (rawPayers.length > 30) return { error: json({ error: 'too many payers (max 30)' }, 400) };
  const cleaned: BillFilters = {
    paidFrom: paidFrom ?? null,
    paidTo: paidTo ?? null,
    payers,
  };
  return { value: cleaned };
}

export function buildFilterWhere(owner: string, filters: BillFilters): { sql: string; binds: unknown[] } {
  const where: string[] = ['owner_id = ?'];
  const binds: unknown[] = [owner];
  if (filters.paidFrom) { where.push('paid_on >= ?'); binds.push(filters.paidFrom); }
  if (filters.paidTo) { where.push('paid_on <= ?'); binds.push(filters.paidTo); }
  if (filters.payers.length) {
    where.push(`payer IN (${filters.payers.map(() => '?').join(',')})`);
    binds.push(...filters.payers);
  }
  return { sql: where.join(' AND '), binds };
}

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
