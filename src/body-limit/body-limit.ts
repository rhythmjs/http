import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export function bodyLimit(maxBytes: number): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    const reject = (): void => {
      ctx.response.status = 413;
      ctx.response.headers.set("content-type", "application/json");
      ctx.response.body = JSON.stringify({ success: false, status: 413, message: "Payload Too Large" });
    };

    const contentLength = ctx.request.headers.get("content-length");
    if (contentLength !== null) {
      if (Number(contentLength) > maxBytes) {
        reject();
        return;
      }
    } else if (ctx.request.body !== null) {
      const buffer = await ctx.request.clone().arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        reject();
        return;
      }
    }

    await next();
  };
}
