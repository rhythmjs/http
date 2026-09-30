# @rhythmjs/http

HTTP utility middleware for [Rhythm](https://github.com/rhythmjs/rhythm) routers and handlers. Each module
is exported by its own subpath — there is no root barrel export.

## Install

```sh
pnpm add @rhythmjs/http @rhythmjs/rhythm @rhythmjs/router
```

## `@rhythmjs/http/cookies`

Parses the request `Cookie` header and exposes a `Cookies` jar on the context for reading and writing.

```ts
import { RhythmRouter } from "@rhythmjs/router";
import { cookies, type CookiesContext } from "@rhythmjs/http/cookies";

new RhythmRouter().use<CookiesContext>(cookies()).get("/", (ctx) => {
  ctx.cookies.get("theme"); // string | undefined
  ctx.cookies.set("theme", "dark", { httpOnly: true, sameSite: "lax", maxAge: 3600 });
  ctx.cookies.delete("legacy");
  ctx.response.body = "ok";
});
```

- `ctx.cookies` — `get(name)`, `getAll()`, `set(name, value, options?)` (defaults to `Path=/`), and
  `delete(name)` (sets `Max-Age=0`). Multiple `set()` calls emit separate `Set-Cookie` headers.
- `CookieOptions` — `domain`, `expires`, `httpOnly`, `maxAge`, `path`, `sameSite`, `secure`.
- The standalone `parseCookies(header)` and `serializeCookie(name, value, options?)` helpers are exported
  too.

## `@rhythmjs/http/session`

Cookie-based sessions with a pluggable store.

```ts
import { session, type SessionContext } from "@rhythmjs/http/session";

new RhythmRouter()
  .use<SessionContext>(session())
  .post("/login", (ctx) => {
    ctx.session.set("user", "ada");
    ctx.response.body = "logged in";
  })
  .get("/me", (ctx) => {
    ctx.response.body = String(ctx.session.get("user") ?? "anonymous");
  })
  .post("/logout", (ctx) => {
    ctx.session.destroy();
    ctx.response.body = "logged out";
  });
```

- `ctx.session` — `id`, `get(key)`, `set(key, value)`, `delete(key)`, `destroy()`.
- The session cookie (`sid` by default; `HttpOnly`, `SameSite=Lax`, `Path=/`) is only written when the
  session is first used, and `destroy()` deletes the stored session and expires the cookie. Unknown or
  expired session ids get a fresh session — the cookie value is never trusted as-is.
- `SessionOptions` — `store` (any object satisfying `SessionStore`; the bundled `memorySessionStore()`
  by default, suitable for a single process), `cookieName`, `maxAge` (seconds, default 86400), `path`,
  `secure`, `sameSite`.

## `@rhythmjs/http/etag`

Adds an `ETag` header derived from the response body (SHA-1) and answers `304 Not Modified` when the
request's `If-None-Match` matches.

```ts
import { etag } from "@rhythmjs/http/etag";

new RhythmRouter().use(etag()).get("/report", (ctx) => {
  ctx.response.body = expensiveReport();
});
```

- `etag({ weak: true })` emits `W/"..."` tags.
- Only successful (2xx) string bodies are tagged; a pre-set `ETag` is left alone.

## `@rhythmjs/http/cache`

Server-side response caching plus a typed `Cache-Control` builder.

```ts
import { cache, cacheControl } from "@rhythmjs/http/cache";

new RhythmRouter()
  .use(cacheControl({ public: true, maxAge: 300, staleWhileRevalidate: 60 }))
  .use(cache({ ttl: 60 }))
  .get("/api/data", (ctx) => {
    ctx.json(expensiveResult());
  });
```

- `cacheControl(options)` — sets `Cache-Control` from typed directives (`maxAge`, `sMaxAge`,
  `staleWhileRevalidate`, `staleIfError`, `public`, `private`, `noCache`, `noStore`, `mustRevalidate`,
  `immutable`) unless the handler already set one. `formatCacheControl(options)` exposes the string
  builder on its own.
- `cache(options)` — caches `200` responses to `GET`/`HEAD` requests and replays them without running
  the handler, with `X-Cache: HIT`/`MISS` and an `Age` header on hits. It never caches responses marked
  `no-store`/`private`, `text/event-stream`, or `Vary: *`; stream bodies are buffered when stored.

`CacheOptions`:

- `ttl` — seconds an entry stays fresh (default `60`).
- `store` — any object satisfying `CacheStore` (`get(key)`, `set(key, entry, ttl)`, `delete(key)`;
  sync or async, entries are plain `{ status, headers, body, storedAt }` data). Defaults to
  `memoryCacheStore()`; back it with Redis etc. to share across processes, and invalidate with
  `store.delete(key)`.
- `keyOf(request)` — cache key (default `METHOD path?query`).
- `vary` — request header names folded into the key (e.g. `["accept-language"]`).
- `filter(ctx)` — veto caching per response.

## `@rhythmjs/http/compress`

Response compression on the web-standard `CompressionStream` — no dependencies, works on every runtime
the router adapters support. Negotiates `gzip` / `deflate` against the request's `Accept-Encoding`
(respecting `;q=0`) and pipes the response body through the winner.

```ts
import { compress } from "@rhythmjs/http/compress";

new RhythmRouter().use(compress()).get("/api/data", (ctx) => {
  ctx.json(bigPayload);
});
```

Options (`CompressOptions`):

- `threshold` — minimum body size in bytes for buffered bodies (default `1024`); streams are always
  compressed since their size is unknown.
- `encodings` — preference order offered to the client (default `["gzip", "deflate"]`).
- `filter(contentType)` — replace the default compressible-type check (`text/*`, JSON, JavaScript, XML,
  SVG, wasm).
- It never touches responses that are `204`/`304`, empty, already `Content-Encoding`-ed,
  `text/event-stream` (compressing SSE buffers events), or non-compressible types, and it appends
  `Vary: Accept-Encoding` wherever negotiation applies.

## `@rhythmjs/http/i18n`

[i18next](https://www.i18next.com/) integration: detects the request language, exposes a
request-scoped translator on the context, and sets the `Content-Language` response header. The
middleware is typed and coupled structurally (`I18nInstanceLike`) rather than against i18next's own
types — every instance capability (`cloneInstance`, `getFixedT`, `changeLanguage`, `init`) is
feature-detected at runtime, so it works across i18next versions (optional peer dependency, any
version) and with any compatible instance.

```ts
import i18next from "i18next";
import { i18n, type I18nContext } from "@rhythmjs/http/i18n";

await i18next.init({
  supportedLngs: ["en", "de"],
  fallbackLng: "en",
  resources: {
    en: { translation: { greeting: "Hello {{name}}" } },
    de: { translation: { greeting: "Hallo {{name}}" } },
  },
});

new RhythmRouter().use<I18nContext>(i18n({ i18next })).get("/greet", (ctx) => {
  ctx.response.body = ctx.t("greeting", { name: "Ada" }); // "Hallo Ada" for ?lng=de
});
```

- `ctx.t` — the instance's own `t` type bound to the detected language (a real i18next instance
  keeps its full `TFunction` typing); `ctx.language` — the resolved language; `ctx.i18n` — a
  request-scoped clone when the instance supports `cloneInstance` (safe for `changeLanguage` per
  request), otherwise a `getFixedT`-based fallback.
- Detection tries `?lng=` querystring, the `i18next` cookie, then `Accept-Language` (ordered by
  quality, matched exactly or by base language against `supportedLngs`), falling back to
  `fallbackLng`. Configure via `detection` — `order` (may include `"path"` for `/de/...`-style
  prefixes with `lookupPath` as the segment index), `lookupQuerystring`, `lookupCookie`,
  `supportedLanguages`, `fallbackLanguage`.
- `cacheCookie: true` persists the resolved language in the detection cookie
  (`cacheCookieMaxAge` seconds, default one year); `contentLanguage: false` disables the response
  header. An uninitialized instance is initialized on first request.
- The standalone `detectLanguage(request, options?)` and `parseAcceptLanguage(header)` helpers are
  exported too.

## `@rhythmjs/http/sse`

Route middleware that applies the Server-Sent Events response headers. The handler owns the body:
assign any `ReadableStream` of SSE frames — driven by a writer, a generator, an observable bridge, or
anything else.

```ts
import { sse } from "@rhythmjs/http/sse";

new RhythmRouter().get("/events", sse(), (ctx) => {
  const encoder = new TextEncoder();
  ctx.response.body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: hello\n\n"));
      controller.close();
    },
  });
});
```

- Defaults, each applied only if absent after the handler runs: `content-type: text/event-stream`,
  `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`
  (disables nginx proxy buffering). Headers set by the handler or by other middleware win over them.
- `SseOptions.headers` — extra headers that override everything, including handler-set values.
- Every server adapter streams `ReadableStream` bodies with backpressure; `ctx.request.signal` aborts
  on client disconnect, so producers can stop cleanly. The body streams after the middleware chain
  resolves, so after-`next()` middleware sees time-to-headers, not the lifetime of the stream.

## `@rhythmjs/http/stream`

Route middleware that applies plain streaming response headers — the non-SSE sibling of
`@rhythmjs/http/sse`. The handler owns the body: assign any `ReadableStream` (progressive text,
NDJSON, LLM tokens, proxied upstream bodies).

```ts
import { stream } from "@rhythmjs/http/stream";

new RhythmRouter().get("/report", stream(), (ctx) => {
  ctx.response.body = upstream.body;
});
```

- Defaults, each applied only if absent after the handler runs: `content-type: text/plain`,
  `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`, and
  `x-content-type-options: nosniff` (stops browsers sniffing the stream into another type). Headers
  set by the handler or by other middleware win over them.
- `StreamOptions.headers` — extra headers that override everything, including handler-set values.
- Same streaming model as `sse`: adapters stream `ReadableStream` bodies with backpressure,
  `ctx.request.signal` aborts on client disconnect, and the body streams after the middleware chain
  resolves.

## `@rhythmjs/http/timeout`

Fails requests that exceed a deadline with `504 { "success": false, "status": 504, "message": "Gateway Timeout" }`.

```ts
import { timeout } from "@rhythmjs/http/timeout";

new RhythmRouter().use(timeout(5000)).get("/slow", async (ctx) => {
  ctx.response.body = await slowUpstream();
});
```

Downstream errors still propagate as errors; only the deadline produces a 504. Note that the downstream
work is not aborted — its result is discarded.

## `@rhythmjs/http/body-limit`

Rejects request bodies larger than a byte limit with `413 Payload Too Large`, using `Content-Length` when
present and measuring the body otherwise.

```ts
import { bodyLimit } from "@rhythmjs/http/body-limit";

new RhythmRouter().use(bodyLimit(1024 * 1024)).post("/upload", async (ctx) => {
  ctx.response.body = "stored";
});
```

## `@rhythmjs/http/multipart`

Parses `multipart/form-data` request bodies once and exposes a `MultipartForm` on the context, with
limits enforced before the handler runs. Uses the runtime's native multipart parser.

```ts
import { multipart, type MultipartContext } from "@rhythmjs/http/multipart";

new RhythmRouter().post("/upload", multipart({ maxBytes: 10_000_000, maxFiles: 3 }), (ctx) => {
  ctx.form.get("title"); // string | undefined
  ctx.form.file("avatar"); // File | undefined
  ctx.form.files(); // File[]
  ctx.response.body = "stored";
});
```

- `ctx.form` — `get(name)` / `getAll(name)` (string fields), `file(name)` / `files(name?)` (`File`
  entries), and `data` (the raw `FormData`).
- Rejections, all as `{ "success": false, "status": ..., "message": ... }`: `415` for non-multipart
  content types, `400` for a missing or malformed body, `413` when `maxBytes` (total body, enforced
  while reading via `Content-Length` or byte counting), `maxFileSize`, `maxFiles`, or `maxFields` is
  exceeded.
- The body is parsed once; downstream middleware and handlers share `ctx.form` instead of re-reading
  the single-use body stream. Fields and files are held in memory — set `maxBytes` in production, and
  keep streaming-to-disk uploads out of scope for this module.

## `@rhythmjs/http/proxy`

A reverse proxy on plain `fetch` and web streams — cross-runtime, no dependencies, request and
response bodies streamed without buffering. The semantics follow
[h3's proxy utilities](https://h3.dev/utils/proxy) (h3 and Rhythm share the srvx foundation), ported
to Rhythm's middleware shape.

```ts
import { proxy } from "@rhythmjs/http/proxy";

new RhythmRouter({ prefix: "/api" }).use(
  proxy({ target: "http://api.internal:8080", rewrite: (path) => path.replace(/^\/api/, "") }),
);
```

The middleware owns the request (it never calls `next()`): the target URL is the `target` base plus
the (rewritten) path and query, and the upstream response is relayed back status-and-all.

Options (`ProxyOptions`):

- `target` — upstream base URL. `rewrite(path)` — adjust the forwarded path.
- `headers` — extra upstream headers; they win over everything.
- **Header hygiene** (h3's two-tier model): hop-by-hop framing headers (`connection`, `te`,
  `upgrade`, `proxy-authorization`, …) and `Connection`-nominated fields are always dropped both
  directions. Soft drops (`host`, `accept-encoding`, `expect`) can be restored via
  `forwardHeaders`; `accept-encoding` is dropped because `fetch` transparently decompresses — which
  is also why stale `content-encoding`/`content-length` are stripped from the response.
- `filterHeaders` — extra request headers to strip. `Cookie` and `Authorization` are forwarded by
  default (correct for a same-trust upstream); strip them here when proxying to an upstream you
  don't fully trust.
- `xfwd` (default `true`) — anti-spoofing `x-forwarded-*`: the client IP (srvx `request.ip`) is
  **appended** to the inbound `x-forwarded-for` chain, while `proto`/`host`/`port` are overwritten
  with server-resolved values so a client-supplied value never reaches the upstream.
- `redirect` (default `"manual"`) — upstream 3xx passes through to the client;
  `locationRewrite` (default `true`) rewrites `Location`/`Refresh` URLs pointing at the target
  origin back to the proxy's origin (or takes a `{ prefix: replacement }` map, nginx
  `proxy_redirect`-style).
- `cookieDomainRewrite` / `cookiePathRewrite` — rewrite `Set-Cookie` `Domain`/`Path` (a string for
  all, or a `{ value: replacement }` map; empty string removes the attribute).
- `timeout` — ms to wait for upstream headers, then `504`; an unreachable upstream is `502`, a
  client disconnect `499`, all in the package's standard JSON error shape.
- `fetch` — injectable transport (tests, custom agents).
- Compose with `@rhythmjs/http/body-limit` in front when proxying untrusted input, and mount auth
  middleware before it like any other route.

## `@rhythmjs/http/request-scope`

Opens a per-request scope (backed by
[`AsyncLocalStorage`](https://nodejs.org/api/async_context.html)) holding the current
`RhythmHttpContext` plus a request-local key-value store, readable anywhere in the call stack — loggers,
database helpers, service functions — without threading `ctx` through every signature.

```ts
import { requestScope, RequestScope } from "@rhythmjs/http/request-scope";

new RhythmRouter()
  .use(requestScope())
  .use(async (_ctx, next) => {
    RequestScope.set("requestId", crypto.randomUUID());
    await next();
  })
  .get("/greet", (ctx) => {
    ctx.response.body = greeting();
  });

// Anywhere else, no ctx parameter needed:
function greeting() {
  const path = new URL(RequestScope.context().request.url).pathname;
  return `Hello from ${path} (request ${RequestScope.get("requestId")})`;
}
```

- `requestScope()` — register it before any middleware or handler that uses `RequestScope`. Each request
  gets its own scope; concurrent requests never see each other's context or store.
- `RequestScope.context<TContext>()` — the current context. Pass your extended context type (e.g.
  `RequestScope.context<RhythmHttpContext & CookiesContext>()`) for typed access to properties added by
  earlier middleware.
- `RequestScope.get(key)` / `set(key, value)` / `has(key)` / `delete(key)` — the request-local store, for
  values that belong to the request but not on the context (request ids, loggers, the authenticated
  user). Augment the `RequestScopeStore` interface via declaration merging to type your keys.
- `RequestScope.run(context, fn)` — open a scope manually, for tests and non-HTTP entry points that reuse
  request-scoped helpers.
- Naming convention: bare accessors (`context()`, `get()`, `set()`, …) throw `RequestScopeError` when no
  scope is active; `contextOrNull()` and `isActive()` never throw, for code that runs both inside and
  outside requests.
- Requires an `AsyncLocalStorage`-capable runtime: Node.js, Bun, and Deno work out of the box; on
  Cloudflare Workers enable the `nodejs_compat` (or `nodejs_als`) compatibility flag.

## Development

```sh
pnpm install
pnpm test       # vp test
pnpm typecheck  # tsc --noEmit
pnpm build      # vp pack
```
