// GET /api/latest?device=<uuid>&kind=<full|probe>
// 拿指定设备指定 kind 的最新一条快照;不传 device 拿所有设备的最新
// 响应: {device, kind, ts, summary, payload} 或 404
import type { PagesFunction } from '@cloudflare/workers-types';
import { normalizeSnapshotSummary } from './_regions.js';

interface Env {
  DB: D1Database;
}

interface SnapshotRow {
  id: number;
  device_uuid: string;
  device_name: string | null;
  kind: string;
  ts: number;
  summary_json: string;
  payload_json: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const device = url.searchParams.get('device')?.trim() || null;
  const kind = url.searchParams.get('kind')?.trim() || 'full';
  if (kind !== 'full' && kind !== 'probe') {
    return json({ error: 'kind must be "full" or "probe"' }, 400);
  }

  const row = device
    ? await context.env.DB
        .prepare(
          `SELECT * FROM snapshots
           WHERE device_uuid = ? AND kind = ?
           ORDER BY ts DESC LIMIT 1`
        )
        .bind(device, kind)
        .first<SnapshotRow>()
    : await context.env.DB
        .prepare(
          `SELECT * FROM snapshots
           WHERE kind = ?
           ORDER BY ts DESC LIMIT 1`
        )
        .bind(kind)
        .first<SnapshotRow>();

  if (!row) {
    return json({ error: 'not found' }, 404);
  }

  // ETag 用 row.id(自增,新行必然 id 不同)— 命中 304 直接省去 JSON parse + 渲染
  // 强 ETag 即可:id 变了 = 新行,内容必然变;客户端无需验证载荷
  const etag = `W/"regions-v2-${row.id}"`;
  if (context.request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const payload = safeParse(row.payload_json);
  const summary = normalizeSnapshotSummary(safeParse(row.summary_json), payload);
  return jsonWithEtag({
    id: row.id,
    device: row.device_uuid,
    deviceName: row.device_name,
    kind: row.kind,
    ts: row.ts,
    summary,
    payload,
  }, etag);
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function jsonWithEtag(obj: unknown, etag: string, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      etag,
      'cache-control': 'private, max-age=0, must-revalidate',
    },
  });
}
