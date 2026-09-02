// GET /api/usage
//
// 拉今天(UTC)账号总量及该 D1 database 的 rowsRead / rowsWritten,前端 widget 用
// 来可视化 free plan 5M rows/day 配额余量。
//
// 走 Cloudflare GraphQL Analytics API(查 metrics 不消耗 D1 read 配额):
//   viewer.accounts[].d1AnalyticsAdaptiveGroups
// 数据保留 31 天,免费。
//
// 配置(在 wrangler.toml 注释 + AGENTS.md):
//   wrangler pages secret put CF_API_TOKEN
//     ← 用户在 dashboard 创建的 API token(Account Analytics: Read 权限,只读 scope)
//   wrangler.toml 里 CF_ACCOUNT_ID / D1_DATABASE_ID 已预填
//
// 边缘 cache 5min — 防 GraphQL 自身 rate limit,前端 5min 拉一次。
// 没配 token 时返回 503 + 帮助信息,前端把 widget 转成"未配置 token"提示。
import type { PagesFunction } from '@cloudflare/workers-types';
import { matchEdgeCache, storeEdgeCache } from './_cache';

interface Env {
  DB: D1Database;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
}

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
// D1 free plan 单日 rowsRead 上限 — 5,000,000(2026-09 仍有效)
// Workers Paid plan 下这个限制消失,数字会到 25B+/月
const FREE_PLAN_DAILY_READ_LIMIT = 5_000_000;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const cached = await matchEdgeCache(context);
  if (cached) return cached;

  const { CF_API_TOKEN, CF_ACCOUNT_ID, D1_DATABASE_ID } = context.env;

  if (!CF_API_TOKEN) {
    return json({
      ok: false,
      code: 'missing_token',
      error: 'CF_API_TOKEN secret 未配置 — widget 无法拉取 D1 用量',
      help: '去 https://dash.cloudflare.com/profile/api-tokens 创建 token(Account Analytics: Read 权限,只读 scope),然后跑 `wrangler pages secret put CF_API_TOKEN` 写入。',
    }, 503);
  }
  if (!CF_ACCOUNT_ID || !D1_DATABASE_ID) {
    return json({
      ok: false,
      code: 'missing_config',
      error: 'wrangler.toml 缺 CF_ACCOUNT_ID 或 D1_DATABASE_ID',
    }, 503);
  }

  // 今天 UTC 0 点
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const query = `
    query D1Usage($accountTag: String!, $databaseId: String!, $start: Date!, $end: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          accountUsage: d1AnalyticsAdaptiveGroups(
            limit: 1
            filter: { date_geq: $start, date_leq: $end }
          ) {
            sum { rowsRead rowsWritten }
          }
          databaseUsage: d1AnalyticsAdaptiveGroups(
            limit: 1
            filter: { date_geq: $start, date_leq: $end, databaseId: $databaseId }
          ) {
            sum { rowsRead rowsWritten }
          }
        }
      }
    }
  `;
  const variables = {
    accountTag: CF_ACCOUNT_ID,
    databaseId: D1_DATABASE_ID,
    start: fmt(startDate),
    // date_leq 是闭区间，起止都用今天；不要意外把明天纳入统计。
    end: fmt(startDate),
  };

  let resp: Response;
  try {
    resp = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    return json({ ok: false, code: 'graphql_fetch_failed', error: 'GraphQL fetch failed: ' + (e instanceof Error ? e.message : String(e)) }, 502);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return json({ ok: false, code: 'graphql_http_' + resp.status, error: `GraphQL ${resp.status}: ${text.slice(0, 200)}` }, 502);
  }
  const body = await resp.json() as {
    data?: {
      viewer: {
        accounts: Array<{
          accountUsage: Array<{
            sum: { rowsRead: number; rowsWritten: number };
          }>;
          databaseUsage: Array<{
            sum: { rowsRead: number; rowsWritten: number };
          }>;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (body.errors && body.errors.length) {
    return json({ ok: false, code: 'graphql_error', error: 'GraphQL error: ' + body.errors.map((e) => e.message).join('; ') }, 502);
  }
  const account = body.data?.viewer?.accounts?.[0];
  if (!account || !Array.isArray(account.accountUsage) || !Array.isArray(account.databaseUsage)) {
    return json({ ok: false, code: 'graphql_missing_data', error: 'Cloudflare 未返回账号用量，无法确认余量' }, 502);
  }
  const sum = account.accountUsage[0]?.sum || { rowsRead: 0, rowsWritten: 0 };
  const databaseSum = account.databaseUsage[0]?.sum || { rowsRead: 0, rowsWritten: 0 };
  const rowsRead = sum.rowsRead || 0;
  const rowsWritten = sum.rowsWritten || 0;

  return storeEdgeCache(context, json({
    ok: true,
    rowsRead,
    rowsWritten,
    scope: 'account',
    databaseRowsRead: databaseSum.rowsRead,
    databaseRowsWritten: databaseSum.rowsWritten,
    remaining: Math.max(0, FREE_PLAN_DAILY_READ_LIMIT - rowsRead),
    observedAt: now.toISOString(),
    limit: FREE_PLAN_DAILY_READ_LIMIT,
    pct: Math.min(100, (rowsRead / FREE_PLAN_DAILY_READ_LIMIT) * 100),
    windowStart: startDate.toISOString(),
    windowEnd: endDate.toISOString(),
    // 当 5M 用满到 100% 时,以用户最近的 read 速率推算还要多久触顶;
    // 没有历史数据(刚启动)就 null,前端 widget 显示"—"
    resetsAt: endDate.toISOString(),
  }), Math.max(1, Math.min(300, Math.floor((endDate.getTime() - now.getTime()) / 1000))));
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
