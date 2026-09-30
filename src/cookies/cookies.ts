import type { DeriveMiddleware, Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

/** Bun's cookie attributes: domain, path, expires, maxAge, secure, httpOnly, sameSite, partitioned. */
export type CookieOptions = Omit<Bun.CookieInit, "name" | "value">;

/** Parse a Cookie header with Bun's native CookieMap (values come back decoded). */
export function parseCookies(header: string | null): Record<string, string> {
  return header === null ? {} : Object.fromEntries(new Bun.CookieMap(header));
}

/** Serialize one Set-Cookie value with Bun's native Cookie (defaults: `Path=/`, `SameSite=Lax`). */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  return Bun.Cookie.from(name, value, options).serialize();
}

export class Cookies {
  #incoming: Bun.CookieMap;
  #headers: Headers;

  constructor(incoming: Bun.CookieMap, headers: Headers) {
    this.#incoming = incoming;
    this.#headers = headers;
  }

  get(name: string): string | undefined {
    return this.#incoming.get(name) ?? undefined;
  }

  has(name: string): boolean {
    return this.#incoming.has(name);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.#incoming);
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    this.#headers.append("set-cookie", serializeCookie(name, value, options));
  }

  delete(name: string, options: CookieOptions = {}): void {
    this.set(name, "", { ...options, expires: undefined, maxAge: 0 });
  }
}

export type CookiesContext = {
  cookies: Cookies;
};

export function cookies(): DeriveMiddleware<RhythmHttpContext, CookiesContext> {
  const middleware: Middleware<RhythmHttpContext & Partial<CookiesContext>> = async (ctx, next) => {
    ctx.cookies = new Cookies(new Bun.CookieMap(ctx.request.headers.get("cookie") ?? ""), ctx.response.headers);
    await next();
  };
  return middleware as DeriveMiddleware<RhythmHttpContext, CookiesContext>;
}
