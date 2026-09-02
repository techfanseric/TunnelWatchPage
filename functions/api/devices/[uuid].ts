// PUT /api/devices/:uuid
// 更新单台设备的静默时段(quietHourStart / quietHourEnd)。
// 鉴权:X-Device-Uuid header 必须等于 path :uuid,且设备必须在 D1 白名单里。
// Body:{ quietHourStart: int 0..1439, quietHourEnd: int 0..1439 },name 字段拒绝(400)。
// 响应 200:{ uuid, name, quietHourStart, quietHourEnd, updatedAt }
// updatedAt 是服务端 UTC ISO 8601 时间戳(无 updated_at 列,见下方说明)。
import type { PagesFunction } from '@cloudflare/workers-types';
import { Env, json, requireDevice } from '../_billing';
import { invalidateKey } from '../_cache';
import { DEVICES_CACHE_KEY } from '../devices';

interface UpdateBody {
  quietHourStart?: unknown;
  quietHourEnd?: unknown;
  name?: unknown;
}

interface DeviceRow {
  uuid: string;
  name: string;
  quiet_hour_start: number;
  quiet_hour_end: number;
}

function parseMinute(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > 1439) return null;
  return value;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
  // 1) 鉴权:requireDevice 处理 401(无 header) + 403(header 不在白名单)
  const auth = await requireDevice(context.request, context.env);
  if (auth instanceof Response) return auth;
  const headerUuid = auth;

  // 2) header uuid 必须 == path uuid,否则无权改这台设备
  const pathUuid = String(context.params.uuid || '').trim();
  if (!pathUuid || headerUuid !== pathUuid) {
    return json({ error: 'device not authorized' }, 403);
  }

  // 3) 解析 body
  let body: UpdateBody;
  try { body = await context.request.json<UpdateBody>(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }
  if (body == null || typeof body !== 'object') {
    return json({ error: 'body must be a JSON object' }, 400);
  }

  // 4) name 字段只读,带了就 400(按 spec §4.2 推荐)
  if (body.name !== undefined) {
    return json({ error: 'name is not editable' }, 400);
  }

  // 5) 校验两个 int 字段在 0..1439
  const start = parseMinute(body.quietHourStart);
  if (start === null) {
    return json({ error: 'quietHourStart must be integer 0-1439' }, 400);
  }
  const end = parseMinute(body.quietHourEnd);
  if (end === null) {
    return json({ error: 'quietHourEnd must be integer 0-1439' }, 400);
  }

  // 6) 写入 D1。devices 表没有 updated_at 列(避免不必要 schema 扩张),
  // updatedAt 直接用服务端当前 UTC ISO 8601,前端用它做乐观更新的版本号。
  const result = await context.env.DB
    .prepare('UPDATE devices SET quiet_hour_start = ?, quiet_hour_end = ? WHERE uuid = ?')
    .bind(start, end, headerUuid)
    .run();
  if (!result.meta.changes) {
    return json({ error: 'device not found' }, 404);
  }

  // GET 会先命中边缘缓存；只清进程内缓存会让刚保存的窗口被旧值覆盖。
  // 清理当前 PoP 的标准列表 URL。其他 PoP 的副本仍受现有 TTL 约束，
  // 此处不是全局即时一致性保证。
  invalidateKey(DEVICES_CACHE_KEY);
  await caches.default.delete(new Request(new URL('/api/devices', context.request.url)));

  // 7) 回读,组装响应
  const row = await context.env.DB
    .prepare('SELECT uuid, name, quiet_hour_start, quiet_hour_end FROM devices WHERE uuid = ?')
    .bind(headerUuid)
    .first<DeviceRow>();
  if (!row) return json({ error: 'device not found' }, 404);

  return json({
    uuid: row.uuid,
    name: row.name,
    quietHourStart: row.quiet_hour_start,
    quietHourEnd: row.quiet_hour_end,
    updatedAt: new Date().toISOString(),
  });
  } catch (e: any) {
    // 上线后保留 catch: 任何 D1 / runtime 异常都用 JSON 返回,而不是 Cloudflare 默认
    // "error code: 1101" 纯文本 — 前端能解析,运维能一眼看到 D1 配额 / SQL 错误等。
    return json({ error: 'INTERNAL', message: String(e?.message ?? e) }, 500);
  }
};
