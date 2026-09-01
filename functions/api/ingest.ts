// POST /api/ingest
// 鉴权:Header X-Device-Uuid 必须在 devices 白名单里
// 15min dedup:同 device+kind 在 15min 窗口内的旧记录先删,再插入新记录
// 失败:4xx 返回 JSON {error} 方便 App 端 log
import type { PagesFunction } from '@cloudflare/workers-types';

interface Env {
  DB: D1Database;
}

interface IngestBody {
  kind: 'full' | 'probe';
  ts: number;
  deviceUuid: string;
  deviceName?: string;
  summary: unknown;
  payload: unknown;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const request = context.request;
  const env = context.env;

  // 1. 鉴权
  const uuid = request.headers.get('X-Device-Uuid')?.trim();
  if (!uuid) {
    return json({ error: 'missing X-Device-Uuid header' }, 401);
  }
  const device = await env.DB
    .prepare('SELECT uuid, name FROM devices WHERE uuid = ?')
    .bind(uuid)
    .first<{ uuid: string; name: string }>();
  if (!device) {
    return json({ error: 'device not authorized', uuid }, 403);
  }

  // 2. 解析 body
  let body: IngestBody;
  try {
    body = (await request.json()) as IngestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (body.kind !== 'full' && body.kind !== 'probe') {
    return json({ error: 'kind must be "full" or "probe"' }, 400);
  }
  if (typeof body.ts !== 'number' || body.ts <= 0) {
    return json({ error: 'ts must be a positive unix-ms' }, 400);
  }
  if (body.deviceUuid !== uuid) {
    return json({ error: 'deviceUuid in body does not match header' }, 400);
  }

  // 3. 15min dedup:删掉同 device+kind 在 15min 窗口内的旧记录
  // (确保窗口内只留最新一条)
  const cutoff = body.ts - FIFTEEN_MIN_MS;
  const delResult = await env.DB
    .prepare('DELETE FROM snapshots WHERE device_uuid = ? AND kind = ? AND ts >= ?')
    .bind(uuid, body.kind, cutoff)
    .run();
  const dedupDeleted = delResult.meta?.changes ?? 0;

  // 4. INSERT 新记录
  const summaryJson = JSON.stringify(body.summary ?? {});
  const payloadJson = JSON.stringify(body.payload ?? {});
  const deviceName = (body.deviceName?.trim() || device.name).slice(0, 64);
  const insResult = await env.DB
    .prepare(
      `INSERT INTO snapshots (device_uuid, device_name, kind, ts, summary_json, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(uuid, deviceName, body.kind, body.ts, summaryJson, payloadJson)
    .run();

  return json({
    ok: true,
    id: insResult.meta?.last_row_id ?? null,
    dedupDeleted,
  });
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
