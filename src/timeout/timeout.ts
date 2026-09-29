import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export function timeout(ms: number): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), ms);
    });

    try {
      const pending = next().then(() => "completed" as const);
      const outcome = await Promise.race([pending, expired]);
      if (outcome === "expired") {
        pending.catch(() => undefined);
        ctx.response.status = 504;
        ctx.response.headers.set("content-type", "application/json");
        ctx.response.body = JSON.stringify({ success: false, status: 504, message: "Gateway Timeout" });
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
