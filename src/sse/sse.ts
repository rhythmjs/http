import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export interface SseOptions {
  headers?: ConstructorParameters<typeof Headers>[0];
}

const defaults: [string, string][] = [
  ["content-type", "text/event-stream; charset=utf-8"],
  ["cache-control", "no-cache, no-transform"],
  ["connection", "keep-alive"],
  ["x-accel-buffering", "no"],
];

export function sse(options: SseOptions = {}): Middleware<RhythmHttpContext> {
  const overrides = new Headers(options.headers);
  return async (ctx, next) => {
    await next();
    for (const [name, value] of defaults) {
      if (!ctx.response.headers.has(name)) ctx.response.headers.set(name, value);
    }
    for (const [name, value] of overrides) {
      ctx.response.headers.set(name, value);
    }
  };
}
