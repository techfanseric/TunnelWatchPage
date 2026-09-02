// GET /api/latest?device=<uuid>&kind=<full|probe>
// 拿指定设备指定 kind 的最新一条快照;不传 device 拿所有设备的最新
// 响应: {device, kind, ts, summary, payload} 或 404
import type { PagesFunction } from '@cloudflare/workers-types';
import { cachedD1, matchEdgeCache, storeEdgeCache } from './_cache';

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

const LATEST_CACHE_TTL_MS = 30_000;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const device = url.searchParams.get('device')?.trim() || null;
  const kind = url.searchParams.get('kind')?.trim() || 'full';
  if (kind !== 'full' && kind !== 'probe') {
    return json({ error: 'kind must be "full" or "probe"' }, 400);
  }

  const edgeHit = await matchEdgeCache(context);
  if (edgeHit) return edgeHit;

  // key 含 device + kind — 不同设备 / 不同 kind 各自独立 cache
  const cacheKey = `GET:/api/latest?device=${device ?? ''}&kind=${kind}`;

  const resp = await cachedD1<Env>(
    cacheKey,
    LATEST_CACHE_TTL_MS,
    async () => {
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
      const payload = safeParse(row.payload_json);
      // ingest 已统一规范化 summary;读取时不要再次遍历大 payload,避免 Free Worker CPU 超限。
      const summary = safeParse(row.summary_json);
      return jsonWithEtag({
        id: row.id,
        device: row.device_uuid,
        deviceName: row.device_name,
        kind: row.kind,
        ts: row.ts,
        summary,
        payload,
      }, etag);
    },
  );

  // 304 处理: 命中 etag 直接返 304,不走 storeEdgeCache(原代码行为)
  const etag = resp.headers.get('etag');
  if (etag && context.request.headers.get('If-None-Match') === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        'x-tw-mem': resp.headers.get('x-tw-mem') ?? 'MISS',
      },
    });
  }

  return storeEdgeCache(context, resp, 120);
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
