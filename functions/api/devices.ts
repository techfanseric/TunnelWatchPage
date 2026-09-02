// GET /api/devices
// 拿授权设备列表 — 前端设备下拉框用
// 响应: { devices: [{uuid, name, createdAt, lastSeenAt, quietHourStart, quietHourEnd}] }
import type { PagesFunction } from '@cloudflare/workers-types';
import { cachedD1, matchEdgeCache, storeEdgeCache } from './_cache';

interface Env {
  DB: D1Database;
}

interface DeviceRow {
  uuid: string;
  name: string;
  created_at: string;
  last_seen_at: number | null;
  quiet_hour_start: number;
  quiet_hour_end: number;
}

// in-memory cache key for the device list. Also targeted by invalidateKey
// from PUT /api/devices/:uuid so the next GET reflects the new quiet hours.
export const DEVICES_CACHE_KEY = 'GET:/api/devices';
const DEVICES_CACHE_TTL_MS = 30_000;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const edgeHit = await matchEdgeCache(context);
  if (edgeHit) return edgeHit;

  const resp = await cachedD1<Env>(
    DEVICES_CACHE_KEY,
    DEVICES_CACHE_TTL_MS,
    async () => {
      const result = await context.env.DB
        .prepare(
          `SELECT
             d.uuid,
             d.name,
             d.created_at,
             d.quiet_hour_start,
             d.quiet_hour_end,
             COALESCE((
               SELECT s.ts
               FROM snapshots s
               WHERE s.device_uuid = d.uuid
               ORDER BY s.ts DESC
               LIMIT 1
             ), 0) AS last_seen_at
           FROM devices d
           ORDER BY d.created_at ASC`
        )
        .all<DeviceRow>();

      return json({
        devices: (result.results || []).map((d) => ({
          uuid: d.uuid,
          name: d.name,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
          quietHourStart: d.quiet_hour_start,
          quietHourEnd: d.quiet_hour_end,
        })),
      });
    },
  );

  return storeEdgeCache(context, resp, 600);
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
