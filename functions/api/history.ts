// GET /api/history?device=<uuid>&hours=<24|168|720>&kind=<full|probe>&bucket=<15m|1h|4h>
// 拿指定设备在指定时间窗口内的所有快照摘要,前端用来画时序图
// 响应: { device, hours, kind, bucket, items: [{id, ts, kind, summary}] }
//
// 数据量估算:
//   24h  15min dedup:  24 * 4 = 96 条/kind;  2 kind × 96 = 192 条 × ~300B = ~60KB
//   7d   1h   dedup:   7 * 24 = 168 条/kind;  2 kind × 168 = 336 条 × ~300B = ~100KB
//   30d  4h   dedup:   30 * 6 = 180 条/kind;  2 kind × 180 = 360 条 × ~300B = ~110KB
//
// 桶化策略(2026-09-01):
//   - 客户端传 hours 决定时间窗
//   - 服务端按 bucket 大小做 GROUP BY,每桶只取**该桶内时间最晚一条**的 summary_json
//   - 桶大小自动派生:hours=24 → 15min, 168 → 1h, 720 → 4h
//   - 客户端可不传 bucket;若传则覆盖默认(供调试)
//   - client 端拿到的 items 还是 [{ts, kind, summary}],直接当窄桶的快照列表用
//   - 缺点:不是真聚合(每桶一个数据点),但保留趋势,前端画图无感
//
// 降采样 SQL(SQLite,兼容 D1):
//   WITH bucketed AS (
//     SELECT
//       (ts / ?) * ? AS bucket_ts,
//       summary_json, kind,
//       ROW_NUMBER() OVER (PARTITION BY (ts / ?) ORDER BY ts DESC) AS rn
//     FROM snapshots
//     WHERE device_uuid = ? AND kind IN ('full','probe') AND ts >= ?
//   )
//   SELECT bucket_ts, kind, summary_json
//   FROM bucketed WHERE rn = 1
//   ORDER BY bucket_ts ASC
import type { PagesFunction } from '@cloudflare/workers-types';

interface Env {
  DB: D1Database;
}

interface SummaryRow {
  id?: number;
  ts: number;
  kind: string;
  summary_json: string;
}

const BUCKET_BY_HOURS: Record<number, { minutes: number; label: string }> = {
  24:  { minutes: 15,  label: '15m' },
  168: { minutes: 60,  label: '1h'  },
  720: { minutes: 240, label: '4h'  },
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const device = url.searchParams.get('device')?.trim();
  const rawHours = parseInt(url.searchParams.get('hours') || '24', 10);
  const hours = [24, 168, 720].includes(rawHours) ? rawHours : 24;
  const kindFilter = url.searchParams.get('kind');

  if (!device) {
    return json({ error: 'device param required' }, 400);
  }
  if (kindFilter && kindFilter !== 'full' && kindFilter !== 'probe') {
    return json({ error: 'kind must be "full" or "probe" or omitted' }, 400);
  }

  const bucketOverride = url.searchParams.get('bucket'); // '15m' | '1h' | '4h' (调试)
  const cfg = BUCKET_BY_HOURS[hours];
  let bucketMs: number;
  let bucketLabel: string;
  if (bucketOverride === '15m' || bucketOverride === '1h' || bucketOverride === '4h') {
    const map: Record<string, number> = { '15m': 15, '1h': 60, '4h': 240 };
    bucketMs = map[bucketOverride] * 60 * 1000;
    bucketLabel = bucketOverride;
  } else {
    bucketMs = cfg.minutes * 60 * 1000;
    bucketLabel = cfg.label;
  }

  const since = Date.now() - hours * 60 * 60 * 1000;

  // D1 / SQLite 不支持同时声明多个相同占位符重复利用(实测 1.x 没问题,但保险起见
  // 用 prepare 出来的语句绑定独立变量,避免 SQL 优化器解析时的歧义)
  const kinds = kindFilter ? [kindFilter] : ['full', 'probe'];
  const placeholders = kinds.map(() => '?').join(',');

  const sql = `
    WITH bucketed AS (
      SELECT
        (ts / ?) * ? AS bucket_ts,
        summary_json,
        kind,
        ROW_NUMBER() OVER (
          PARTITION BY (ts / ?)
          ORDER BY ts DESC
        ) AS rn
      FROM snapshots
      WHERE device_uuid = ?
        AND kind IN (${placeholders})
        AND ts >= ?
    )
    SELECT bucket_ts AS ts, kind, summary_json
    FROM bucketed
    WHERE rn = 1
    ORDER BY ts ASC
  `;

  const stmt = context.env.DB.prepare(sql).bind(
    bucketMs, bucketMs,   // PARTITION BY (ts / ?),bucket_ts
    bucketMs,             // PARTITION BY
    device,
    ...kinds,
    since
  );

  const result = await stmt.all<SummaryRow>();
  const items = (result.results || []).map((r) => ({
    ts: r.ts,
    kind: r.kind,
    summary: safeParse(r.summary_json),
  }));

  return json({
    device,
    hours,
    kind: kindFilter || 'all',
    bucket: bucketLabel,
    items,
  });
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
