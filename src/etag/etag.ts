import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export interface EtagOptions {
  weak?: boolean;
}

function hash(body: string): string {
  return new Bun.CryptoHasher("sha1").update(body).digest("hex");
}

export function etag(options: EtagOptions = {}): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    await next();

    const { response } = ctx;
    if (response.status < 200 || response.status >= 300) return;
    if (typeof response.body !== "string") return;
    if (response.headers.get("etag") !== null) return;

    const tag = `${options.weak ? "W/" : ""}"${hash(response.body)}"`;
    response.headers.set("etag", tag);

    const ifNoneMatch = ctx.request.headers.get("if-none-match");
    if (ifNoneMatch !== null && ifNoneMatch.split(/\s*,\s*/).includes(tag)) {
      response.status = 304;
      response.statusText = "Not Modified";
      response.body = null;
      response.headers.delete("content-length");
    }
  };
}
