// GET /api/devices
// 拿授权设备列表 — 前端设备下拉框用
// 响应: { devices: [{uuid, name, createdAt, lastSeenAt}] }
import type { PagesFunction } from '@cloudflare/workers-types';

interface Env {
  DB: D1Database;
}

interface DeviceRow {
  uuid: string;
  name: string;
  created_at: string;
  last_seen_at: number | null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const result = await context.env.DB
    .prepare(
      `SELECT
         d.uuid,
         d.name,
         d.created_at,
         COALESCE(MAX(s.ts), 0) AS last_seen_at
       FROM devices d
       LEFT JOIN snapshots s ON s.device_uuid = d.uuid
       GROUP BY d.uuid, d.name, d.created_at
       ORDER BY d.created_at ASC`
    )
    .all<DeviceRow>();

  return json({
    devices: (result.results || []).map((d) => ({
      uuid: d.uuid,
      name: d.name,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
    })),
  });
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
