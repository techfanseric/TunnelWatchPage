import type { PagesFunction } from '@cloudflare/workers-types';

/** Keep D1 failures machine-readable, including failures during device authorization. */
export const onRequest: PagesFunction = async (context) => {
  try {
    return await context.next();
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current != null; depth++) {
      messages.push(current instanceof Error ? current.message : String(current));
      current = current instanceof Error ? current.cause : null;
    }
    const quotaExceeded = messages.some(message => message.includes("exceeded D1's free tier daily row read limit"));
    // Never return SQL, stack traces, credentials, or arbitrary exception text.
    const code = quotaExceeded ? 'D1_DAILY_READ_LIMIT' : 'INTERNAL_ERROR';
    const message = quotaExceeded
      ? '云端 D1 配额已满，每日北京时间 08:00（UTC 00:00）重置；有缓存时可离线查看'
      : '云端服务暂时异常，请稍后重试';
    console.error(`API request failed: ${code}`);
    return new Response(JSON.stringify({ error: code, message }), {
      status: quotaExceeded ? 503 : 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
};
