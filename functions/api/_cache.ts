import type { EventContext } from '@cloudflare/workers-types';

type PagesContext<Env = unknown> = EventContext<Env, string, Record<string, unknown>>;

// ============================================================================
// 边缘 cache (existing) — Workers Cache API,跨 worker instance 复用
// ============================================================================

// Pages Functions are not cached by Cloudflare automatically. Keep the D1-backed
// GET endpoints in the Cache API so many browser refreshes share one database read.
export async function matchEdgeCache<Env>(context: PagesContext<Env>): Promise<Response | null> {
  const cached = await caches.default.match(context.request);
  if (!cached) return null;

  const etag = cached.headers.get('etag');
  if (etag && context.request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'x-tw-cache': 'HIT' } });
  }

  const response = new Response(cached.body, cached);
  response.headers.set('x-tw-cache', 'HIT');
  return response;
}

export function storeEdgeCache<Env>(
  context: PagesContext<Env>,
  response: Response,
  ttlSeconds: number,
): Response {
  if (response.status !== 200) return response;

  const cacheable = new Response(response.body, response);
  cacheable.headers.set('cache-control', `public, max-age=0, s-maxage=${ttlSeconds}`);
  cacheable.headers.set('x-tw-cache', 'MISS');
  context.waitUntil(caches.default.put(context.request, cacheable.clone()));
  return cacheable;
}

// ============================================================================
// 模块级 in-memory cache (new, 2026-09-02 quota 应急)
//
// 目的:D1 read quota 满时减少重复 D1 read。in-memory cache 比 edge cache 更快
// (无网络、零序列化),但只在 worker 单 instance 内有效 — 跨 instance 仍由 edge
// cache 兜底。
//
// 设计要点:
// - body 以 ArrayBuffer 存,避免 Response body stream 单次读取的限制 —
//   spec 草稿写的 `resp.clone()` 方案只能 hit 一次,后续 hit body 是空的。
// - 只 cache 2xx(默认 status === 200,endpoint 可自定义 isCacheable)。
// - 失败(fn 抛异常)不 cache,直接抛给上层。
// ============================================================================

interface MemoryCacheEntry {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryCacheEntry>();

/**
 * 走 in-memory Map first,miss 才调 fn。
 *
 * - 命中 → 返回缓存的 Response(加 `x-tw-mem: HIT` header 方便 curl 调试)
 * - miss → 调 fn(),2xx 才存(避免 cache 5xx 错误响应)
 * - fn 抛异常 → 不 cache,直接抛给上层
 *
 * @param key          cache key,各 endpoint 决定 key 内容
 * @param ttlMs        缓存有效期(毫秒)
 * @param fn           miss 时调的函数,返回 Response
 * @param isCacheable  决定 response 是否值得缓存,默认 `r => r.status === 200`
 */
export async function cachedD1<Env>(
  key: string,
  ttlMs: number,
  fn: () => Promise<Response>,
  isCacheable: (resp: Response) => boolean = (r) => r.status === 200,
): Promise<Response> {
  const now = Date.now();
  const hit = memoryCache.get(key);
  if (hit && hit.expiresAt > now) {
    return new Response(hit.body, {
      status: hit.status,
      statusText: hit.statusText,
      headers: new Headers({ ...hit.headers, 'x-tw-mem': 'HIT' }),
    });
  }
  const resp = await fn();
  if (isCacheable(resp)) {
    const body = await resp.arrayBuffer();
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });
    memoryCache.set(key, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
      body,
      expiresAt: now + ttlMs,
    });
    // resp.body 已经被 arrayBuffer() 读完了,需要重新构造一个 Response 给 caller
    // (caller 后续会经过 storeEdgeCache 再读 body,不能让它读到 disturbed stream)
    const fresh = new Response(body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: new Headers({ ...headers, 'x-tw-mem': 'MISS' }),
    });
    return fresh;
  }
  // 非 cacheable(默认 status !== 200)— 直接标记 MISS 返回,不入 cache
  resp.headers.set('x-tw-mem', 'MISS');
  return resp;
}

/**
 * 清空整个 in-memory cache — 给测试 / 紧急恢复用。生产代码尽量用 invalidateKey。
 */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

/**
 * 精确清掉某个 key 的 cache。写路径成功后用,避免下次 GET 拿到旧值。
 *
 * @returns 是否真的删了一条(没命中返 false)
 */
export function invalidateKey(key: string): boolean {
  return memoryCache.delete(key);
}

/**
 * 批量清掉 key 前缀匹配的所有 cache(目前没 endpoint 用,留接口备用)。
 *
 * @returns 实际删掉的条目数
 */
export function invalidatePrefix(prefix: string): number {
  let count = 0;
  for (const k of memoryCache.keys()) {
    if (k.startsWith(prefix)) {
      memoryCache.delete(k);
      count++;
    }
  }
  return count;
}
