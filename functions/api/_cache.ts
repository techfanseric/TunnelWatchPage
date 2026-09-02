import type { EventContext } from '@cloudflare/workers-types';

type PagesContext<Env = unknown> = EventContext<Env, string, Record<string, unknown>>;

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
