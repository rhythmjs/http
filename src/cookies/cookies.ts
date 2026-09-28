import type { Middleware } from "@rhythmjs/rhythm";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "strict" | "lax" | "none";
  secure?: boolean;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge !== undefined) cookie += `; Max-Age=${Math.trunc(options.maxAge)}`;
  if (options.domain !== undefined) cookie += `; Domain=${options.domain}`;
  if (options.path !== undefined) cookie += `; Path=${options.path}`;
  if (options.expires !== undefined) cookie += `; Expires=${options.expires.toUTCString()}`;
  if (options.httpOnly) cookie += "; HttpOnly";
  if (options.secure) cookie += "; Secure";
  if (options.sameSite !== undefined) {
    cookie += `; SameSite=${options.sameSite.charAt(0).toUpperCase()}${options.sameSite.slice(1)}`;
  }
  return cookie;
}

export class Cookies {
  #incoming: Record<string, string>;
  #headers: Headers;

  constructor(incoming: Record<string, string>, headers: Headers) {
    this.#incoming = incoming;
    this.#headers = headers;
  }

  get(name: string): string | undefined {
    return this.#incoming[name];
  }

  getAll(): Record<string, string> {
    return { ...this.#incoming };
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    this.#headers.append("set-cookie", serializeCookie(name, value, { path: "/", ...options }));
  }

  delete(name: string, options: CookieOptions = {}): void {
    this.set(name, "", { ...options, expires: undefined, maxAge: 0 });
  }
}

export type CookiesContext = {
  cookies: Cookies;
};

export function cookies(): Middleware<RhythmHttpContext> {
  return async (ctx, next) => {
    const jar = new Cookies(parseCookies(ctx.request.headers.get("cookie")), ctx.response.headers);
    await next({ cookies: jar } satisfies CookiesContext);
  };
}
