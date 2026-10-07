import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export interface StreamOptions {
  headers?: ConstructorParameters<typeof Headers>[0];
}

const defaults: [string, string][] = [
  ["content-type", "text/plain; charset=utf-8"],
  ["cache-control", "no-cache, no-transform"],
  ["connection", "keep-alive"],
  ["x-accel-buffering", "no"],
  ["x-content-type-options", "nosniff"],
];

export function stream(options: StreamOptions = {}): Middleware<RhythmHttpContext> {
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
