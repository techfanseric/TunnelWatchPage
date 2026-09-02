// POST /api/ingest
// 鉴权:Header X-Device-Uuid 必须在 devices 白名单里
// 15min dedup:同 device+kind 在 15min 窗口内的旧记录先删,再插入新记录
// 失败:4xx 返回 JSON {error} 方便 App 端 log
import type { PagesFunction } from '@cloudflare/workers-types';
import { normalizeSnapshotSummary } from './_regions.js';

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
const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

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

  // Bound history query cost: the UI only exposes a 30d window, with 5d spare.
  const pruneResult = await env.DB
    .prepare('DELETE FROM snapshots WHERE device_uuid = ? AND ts < ?')
    .bind(uuid, Date.now() - RETENTION_MS)
    .run();
  const pruned = pruneResult.meta?.changes ?? 0;

  // 4. INSERT 新记录
  // Agent 的地区解析规则可能滞后；展示端在唯一入口统一按原始 lines 重算，
  // 确保地区卡片、地图和历史趋势都读取同一份规范化 summary。
  const normalizedSummary = normalizeSnapshotSummary(body.summary, body.payload);
  const summaryJson = JSON.stringify(normalizedSummary);
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
    pruned,
  });
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
