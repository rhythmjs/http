import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface ProxyOptions {
  target: string;
  rewrite?: (path: string) => string;
  headers?: Record<string, string>;
  forwardHeaders?: string[];
  filterHeaders?: string[];
  xfwd?: boolean;
  timeout?: number;
  redirect?: "manual" | "follow";
  cookieDomainRewrite?: string | Record<string, string>;
  cookiePathRewrite?: string | Record<string, string>;
  locationRewrite?: boolean | Record<string, string>;
  fetch?: (request: Request) => Promise<Response>;
}

const IGNORED_REQUEST_HEADERS = new Set([
  "transfer-encoding",
  "accept-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "expect",
  "te",
  "trailer",
  "host",
  "proxy-authorization",
  "proxy-connection",
]);

const FRAMING_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
]);

const IGNORED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "upgrade",
  "trailer",
  "te",
]);

function connectionTokens(connection: string | null): Set<string> {
  return new Set(
    (connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function rewriteCookieProperty(header: string, map: string | Record<string, string>, property: string): string {
  const rules = typeof map === "string" ? { "*": map } : map;
  return header.replace(new RegExp(`(;\\s*${property}=)([^;]+)`, "gi"), (match, prefix: string, value: string) => {
    let replacement;
    if (Object.hasOwn(rules, value)) replacement = rules[value];
    else if (Object.hasOwn(rules, "*")) replacement = rules["*"];
    else return match;
    return replacement ? prefix + replacement : "";
  });
}

function rewriteRedirectUrl(
  value: string,
  rewrite: true | Record<string, string>,
  targetOrigin: string,
  requestOrigin: string,
): string {
  if (rewrite === true) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return value;
    }
    if (parsed.origin !== targetOrigin) return value;
    return `${requestOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  for (const prefix of Object.keys(rewrite)) {
    if (value.startsWith(prefix)) return `${rewrite[prefix]}${value.slice(prefix.length)}`;
  }
  return value;
}

function buildProxyHeaders(ctx: RhythmHttpContext, options: ProxyOptions): Headers {
  const forwardable = new Set((options.forwardHeaders ?? []).map((name) => name.toLowerCase()));
  const filtered = new Set((options.filterHeaders ?? []).map((name) => name.toLowerCase()));
  const hopByHop = connectionTokens(ctx.request.headers.get("connection"));

  const headers = new Headers();
  for (const [name, value] of ctx.request.headers) {
    if (filtered.has(name)) continue;
    if (FRAMING_HEADERS.has(name) || hopByHop.has(name)) continue;
    if (IGNORED_REQUEST_HEADERS.has(name) && !forwardable.has(name)) continue;
    headers.set(name, value);
  }

  if (options.xfwd ?? true) {
    const url = new URL(ctx.request.url);
    const ip = (ctx.request as { ip?: string }).ip;
    if (ip !== undefined && ip !== "") {
      const chain = headers.get("x-forwarded-for");
      headers.set("x-forwarded-for", chain === null ? ip : `${chain}, ${ip}`);
    }
    const proto = url.protocol.slice(0, -1);
    headers.set("x-forwarded-proto", proto);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-port", url.port || (proto === "https" ? "443" : "80"));
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  return headers;
}

function buildTargetUrl(requestUrl: string, options: ProxyOptions): { url: URL; targetOrigin: string } {
  const url = new URL(requestUrl);
  const target = new URL(options.target);
  const path = options.rewrite === undefined ? url.pathname : options.rewrite(url.pathname);
  const basePath = target.pathname.endsWith("/") ? target.pathname.slice(0, -1) : target.pathname;
  const joined = new URL(`${basePath}${path.startsWith("/") ? path : `/${path}`}${url.search}`, target.origin);
  return { url: joined, targetOrigin: target.origin };
}

function relayError(ctx: RhythmHttpContext, status: number, statusText: string): void {
  ctx.response.status = status;
  ctx.response.statusText = statusText;
  ctx.response.headers.set("content-type", "application/json");
  ctx.response.body = JSON.stringify({ success: false, status, message: statusText });
}

export function proxy(options: ProxyOptions): Middleware<RhythmHttpContext> {
  const fetchImpl = options.fetch ?? ((request: Request) => fetch(request));
  const locationRewrite = options.locationRewrite ?? true;

  return async (ctx) => {
    const { url, targetOrigin } = buildTargetUrl(ctx.request.url, options);
    const requestOrigin = new URL(ctx.request.url).origin;
    const method = ctx.request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? null : ctx.request.body;

    const controller = new AbortController();
    let timedOut = false;
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, options.timeout);

    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: buildProxyHeaders(ctx, options),
      redirect: options.redirect ?? "manual",
      signal: AbortSignal.any([ctx.request.signal, controller.signal]),
      ...(body === null ? {} : { body, duplex: "half" }),
    };

    let upstream: Response;
    try {
      upstream = await fetchImpl(new Request(url, init));
    } catch (error) {
      if (timedOut) return relayError(ctx, 504, "Gateway Timeout");
      if (ctx.request.signal.aborted) return relayError(ctx, 499, "Client Closed Request");
      void error;
      return relayError(ctx, 502, "Bad Gateway");
    } finally {
      clearTimeout(timer);
    }

    ctx.response.status = upstream.status;
    ctx.response.statusText = upstream.statusText;

    const upstreamHopByHop = connectionTokens(upstream.headers.get("connection"));
    for (const [name, value] of upstream.headers) {
      if (name === "set-cookie") continue;
      if (IGNORED_RESPONSE_HEADERS.has(name) || upstreamHopByHop.has(name)) continue;
      if (locationRewrite !== false && (name === "location" || name === "refresh")) {
        if (name === "location") {
          ctx.response.headers.set(name, rewriteRedirectUrl(value, locationRewrite, targetOrigin, requestOrigin));
        } else {
          const match = /^(.*?url=)(.+)$/i.exec(value);
          const rewritten =
            match === null
              ? value
              : `${match[1]}${rewriteRedirectUrl(match[2]!, locationRewrite, targetOrigin, requestOrigin)}`;
          ctx.response.headers.set(name, rewritten);
        }
        continue;
      }
      ctx.response.headers.set(name, value);
    }

    for (const cookie of upstream.headers.getSetCookie()) {
      let value = cookie;
      if (options.cookieDomainRewrite !== undefined) {
        value = rewriteCookieProperty(value, options.cookieDomainRewrite, "domain");
      }
      if (options.cookiePathRewrite !== undefined) {
        value = rewriteCookieProperty(value, options.cookiePathRewrite, "path");
      }
      ctx.response.headers.append("set-cookie", value);
    }

    ctx.response.body = upstream.body;
  };
}
