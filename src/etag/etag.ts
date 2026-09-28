import type { Middleware } from "@rhythmjs/rhythm";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface EtagOptions {
  weak?: boolean;
}

async function hash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function etag(options: EtagOptions = {}): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    await next();

    const { response } = ctx;
    if (response.status < 200 || response.status >= 300) return;
    if (typeof response.body !== "string") return;
    if (response.headers.get("etag") !== null) return;

    const tag = `${options.weak ? "W/" : ""}"${await hash(response.body)}"`;
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
