import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export interface CacheControlOptions {
  maxAge?: number;
  sMaxAge?: number;
  staleWhileRevalidate?: number;
  staleIfError?: number;
  public?: boolean;
  private?: boolean;
  noCache?: boolean;
  noStore?: boolean;
  mustRevalidate?: boolean;
  immutable?: boolean;
}

export function formatCacheControl(options: CacheControlOptions): string {
  const directives: string[] = [];
  if (options.public) directives.push("public");
  if (options.private) directives.push("private");
  if (options.maxAge !== undefined) directives.push(`max-age=${options.maxAge}`);
  if (options.sMaxAge !== undefined) directives.push(`s-maxage=${options.sMaxAge}`);
  if (options.staleWhileRevalidate !== undefined)
    directives.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  if (options.staleIfError !== undefined) directives.push(`stale-if-error=${options.staleIfError}`);
  if (options.noCache) directives.push("no-cache");
  if (options.noStore) directives.push("no-store");
  if (options.mustRevalidate) directives.push("must-revalidate");
  if (options.immutable) directives.push("immutable");
  return directives.join(", ");
}

export function cacheControl(options: CacheControlOptions): Middleware<RhythmHttpContext> {
  const value = formatCacheControl(options);

  return async (ctx, next) => {
    await next();
    if (!ctx.response.headers.has("cache-control")) ctx.response.headers.set("cache-control", value);
  };
}

export interface CacheEntry {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
  storedAt: number;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined> | CacheEntry | undefined;
  set(key: string, entry: CacheEntry, ttl: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface MemoryCacheStoreOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
}

export function memoryCacheStore(options: MemoryCacheStoreOptions = {}): CacheStore {
  const maxEntries = options.maxEntries ?? 1024;
  const maxEntryBytes = options.maxEntryBytes ?? 1024 * 1024;
  const entries = new Map<string, { entry: CacheEntry; expires: number }>();
  let nextSweep = 0;

  return {
    get(key: string): CacheEntry | undefined {
      const cached = entries.get(key);
      if (cached === undefined) return undefined;
      if (cached.expires <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, cached);
      return cached.entry;
    },
    set(key: string, entry: CacheEntry, ttl: number): void {
      if (entry.body.byteLength > maxEntryBytes) return;
      const now = Date.now();
      if (now >= nextSweep) {
        for (const [id, cached] of entries) if (cached.expires <= now) entries.delete(id);
        nextSweep = now + ttl * 1000;
      }
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { entry, expires: now + ttl * 1000 });
    },
    delete(key: string): void {
      entries.delete(key);
    },
  };
}

export interface CacheOptions {
  ttl?: number;
  store?: CacheStore;
  keyOf?: (request: Request) => string | Promise<string>;
  vary?: string[];
  cookies?: boolean;
  filter?: (ctx: RhythmHttpContext) => boolean | Promise<boolean>;
}

const CACHEABLE_METHODS = new Set(["GET", "HEAD"]);
const UNCACHEABLE_CONTROL = /\b(no-store|private)\b/i;
const AUTHORIZED_CACHEABLE = /\b(public|s-maxage|must-revalidate)\b/i;

function defaultKey(request: Request): string {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
}

async function bufferBody(response: RhythmHttpContext["response"]): Promise<Uint8Array> {
  const bytes = await new Response(response.body).arrayBuffer();
  return new Uint8Array(bytes);
}

export function cache(options: CacheOptions = {}): Middleware<RhythmHttpContext> {
  const ttl = options.ttl ?? 60;
  const store = options.store ?? memoryCacheStore();
  const keyOf = options.keyOf ?? defaultKey;
  const vary = options.vary ?? [];
  const filter = options.filter;
  const cookies = options.cookies ?? false;

  const fullKey = async (request: Request): Promise<string> => {
    let key = await keyOf(request);
    for (const name of vary) key += `|${name}:${request.headers.get(name) ?? ""}`;
    return key;
  };

  return async (ctx, next) => {
    if (!CACHEABLE_METHODS.has(ctx.request.method) || (!cookies && ctx.request.headers.has("cookie"))) {
      await next();
      return;
    }

    const key = await fullKey(ctx.request);
    const hit = await store.get(key);
    if (hit !== undefined) {
      ctx.response.status = hit.status;
      for (const [name, value] of hit.headers) ctx.response.headers.set(name, value);
      ctx.response.body = hit.body.slice();
      ctx.response.headers.set("age", String(Math.max(0, Math.floor((Date.now() - hit.storedAt) / 1000))));
      ctx.response.headers.set("x-cache", "HIT");
      return;
    }

    await next();

    const { response } = ctx;
    response.headers.set("x-cache", "MISS");
    if (response.status !== 200 || response.body === null) return;
    if (UNCACHEABLE_CONTROL.test(response.headers.get("cache-control") ?? "")) return;
    if (/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) return;
    if (response.headers.get("vary")?.includes("*")) return;
    if (response.headers.has("set-cookie")) return;
    if (
      ctx.request.headers.has("authorization") &&
      !AUTHORIZED_CACHEABLE.test(response.headers.get("cache-control") ?? "")
    )
      return;
    if (response.body instanceof FormData || response.body instanceof URLSearchParams) return;
    if (response.body instanceof ReadableStream) return;
    if (filter !== undefined && !(await filter(ctx))) return;

    const body = await bufferBody(response);
    response.body = body.slice();
    const headers = [...response.headers.entries()].filter(([name]) => name !== "x-cache" && name !== "age");
    await store.set(key, { status: response.status, headers, body, storedAt: Date.now() }, ttl);
  };
}
