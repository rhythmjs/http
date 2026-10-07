import type { Middleware, Next } from "@rhythmjs/rhythm/types";
import { addRoute, createRouter, findRoute } from "rou3";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export type MountHandler<TContext extends RhythmHttpContext = RhythmHttpContext> = (
  ctx: TContext,
  next: Next,
) => Response | void | Promise<Response | void>;

function apply(ctx: RhythmHttpContext, response: Response): void {
  ctx.response.status = response.status;
  ctx.response.statusText = response.statusText;
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") ctx.response.headers.append(name, value);
    else ctx.response.headers.set(name, value);
  }
  ctx.response.body = response.body;
}

export function mount<TContext extends RhythmHttpContext = RhythmHttpContext>(
  path: string,
  handler: MountHandler<TContext>,
): Middleware<TContext> {
  if (!path.startsWith("/")) throw new TypeError(`mount path must start with "/", got "${path}"`);

  const router = createRouter<true>();
  addRoute(router, "", path, true);

  return async (ctx, next) => {
    if (findRoute(router, ctx.request.method, new URL(ctx.request.url).pathname) === undefined) {
      await next();
      return;
    }

    const response = await handler(ctx, next);
    if (response instanceof Response) apply(ctx, response);
  };
}
