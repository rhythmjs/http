import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

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
        ctx.json({ success: false, status: 504, message: "Gateway Timeout" }, 504);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
