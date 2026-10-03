import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export function bodyLimit(maxBytes: number): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    const reject = (): void => {
      ctx.json({ success: false, status: 413, message: "Payload Too Large" }, 413);
    };

    const declared = Number(ctx.request.headers.get("content-length") ?? NaN);
    if (Number.isSafeInteger(declared) && declared >= 0) {
      if (declared > maxBytes) {
        reject();
        return;
      }
    } else if (ctx.request.body !== null) {
      const reader = ctx.request.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          reject();
          return;
        }
        chunks.push(value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const headers = new Headers(ctx.request.headers);
      headers.delete("content-length");
      const replacement = new Request(ctx.request.url, { method: ctx.request.method, headers, body });
      const ip = (ctx.request as { ip?: string }).ip;
      if (ip !== undefined) (replacement as { ip?: string }).ip = ip;
      (ctx as { request: Request }).request = replacement;
    }

    await next();
  };
}
