import type { PagesFunction } from '@cloudflare/workers-types';
import { Env, PERSONAL_OWNER, json, parseFilters, requireDevice } from '../_billing';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const device = await requireDevice(context.request, context.env);
  if (device instanceof Response) return device;
  let body: unknown;
  try { body = await context.request.json(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }
  const parsed = parseFilters(body);
  if (!parsed.value) return parsed.error!;
  const token = crypto.randomUUID().replaceAll('-', '');
  await context.env.DB.prepare(
    `INSERT INTO bill_share_filters (token, owner_id, filters_json) VALUES (?, ?, ?)`
  ).bind(token, PERSONAL_OWNER, JSON.stringify(parsed.value)).run();
  const origin = new URL(context.request.url).origin;
  return json({
    token,
    filters: parsed.value,
    shareUrl: `${origin}/?share=${encodeURIComponent(token)}`,
  }, 201);
};
