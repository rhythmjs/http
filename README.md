# @rhythmjs/http

HTTP utility middleware for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend
framework: cookies, sessions, ETags, caching, compression, i18n, SSE and streaming, timeouts, body
limits, multipart uploads, and request scoping.

Everything here is plain middleware over the request context (`RhythmHttpContext` from
`@rhythmjs/router/context`). You attach it to a `RhythmRouter` (`router.use(...)` or as a route's
leading handler) or to the `Rhythm` app that mounts your routers. Each module has its own subpath;
there is no root export.

## Install

```sh
bun add @rhythmjs/http @rhythmjs/rhythm @rhythmjs/router
```

| Package            | Required | Minimum version                                         |
| ------------------ | -------- | ------------------------------------------------------- |
| `@rhythmjs/rhythm` | yes      | `0.0.18`                                                |
| `@rhythmjs/router` | yes      | `0.0.18`                                                |
| `i18next`          | optional | any; only for `@rhythmjs/http/i18n` (`bun add i18next`) |
| Bun                | yes      | `1.2.0`                                                 |

The package targets Bun (it uses `Bun.CookieMap`, `Bun.gzipSync`, `Bun.zstdCompressSync`,
`Bun.CryptoHasher`). The samples below were written against Rhythm `0.0.20`.

## Use it with Rhythm

### A minimal app

Routers are built with `RhythmRouter`, mounted into a `Rhythm` app with `mount(router)`, and the app
is served with `Bun.serve` through `toFetchHandler`:

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { cookies } from "@rhythmjs/http/cookies";

const api = new RhythmRouter({ name: "api" })
  .use(cookies())
  .get("/theme", (ctx) => ctx.text(ctx.cookies.get("theme") ?? "light"));

const app = new Rhythm().use(mount(api));

Bun.serve({ fetch: toFetchHandler(app) });
```

`toFetchHandler(app)` returns a `(request, server)` function, which is exactly the signature Bun
calls `fetch` with. Passing it straight as `fetch` hands Bun's `server` through, so `ctx.server` is
the typed `Bun.Server` in every handler. Errors thrown by handlers reject; wrap the call and use
`errorToResponse` from `@rhythmjs/router/fetch` if you want them turned into responses.

### Router middleware vs app middleware

- **On a router** (`router.use(mw)`): runs only when one of that router's routes matches, and a
  middleware that adds to the context (`cookies()`, `session()`, `i18n()`, `multipart()`) widens the
  type for every handler after it. This is the right place for anything handlers read from `ctx`.
  A route can also take middleware as its first handler: `router.post("/upload", multipart(), handler)`.
- **On the app** (`app.use(mw)`): runs for every request that reaches it, whether or not a route
  matches, which is what you want for cross-cutting concerns that wrap the whole response
  (`requestScope`, `timeout`, `compress`, `etag`). An app that uses HTTP middleware before it mounts
  any router has to declare the HTTP context as its input:

```ts
import type { RhythmHttpContext } from "@rhythmjs/router/context";

const app = new Rhythm<{}, RhythmHttpContext>().use(timeout(5000));
```

Once a router is mounted the app's input already includes the HTTP context, so `new Rhythm()` is
enough when the first step is `mount(...)`.

Middleware is an onion: code before `await next()` runs on the way in, code after it runs on the way
out in reverse order. Most modules in this package (`etag`, `compress`, `cache`, `cacheControl`,
`sse`, `stream`, `session`, `i18n`) act after `next()`, on the finished response, so their position
decides what they see. Put `compress` outermost, then `etag` inside it, so the tag is computed over
the uncompressed body and `compress` skips the resulting `304`.

### Several middlewares together

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RequestScope, requestScope } from "@rhythmjs/http/request-scope";
import { timeout } from "@rhythmjs/http/timeout";
import { compress } from "@rhythmjs/http/compress";
import { etag } from "@rhythmjs/http/etag";
import { bodyLimit } from "@rhythmjs/http/body-limit";
import { cookies } from "@rhythmjs/http/cookies";
import { session } from "@rhythmjs/http/session";
import { multipart } from "@rhythmjs/http/multipart";

const api = new RhythmRouter({ name: "api" })
  .use(bodyLimit(1024 * 1024))
  .use(cookies())
  .use(session())
  .post("/login", (ctx) => {
    ctx.session.regenerate();
    ctx.session.set("user", "ada");
    ctx.cookies.set("seen", "1", { maxAge: 3600 });
    ctx.json({ ok: true });
  })
  .get("/me", (ctx) => {
    ctx.json({ user: ctx.session.get<string>("user") ?? null, requestId: RequestScope.get("requestId") });
  })
  .post("/upload", multipart({ maxFiles: 3 }), (ctx) => {
    ctx.json({ title: ctx.form.get("title"), files: ctx.form.files().length });
  });

const app = new Rhythm<{}, RhythmHttpContext>()
  .use(requestScope())
  .use(timeout(5000))
  .use(compress())
  .use(etag())
  .use(mount(api));

Bun.serve({ fetch: toFetchHandler(app) });
```

Typical order, outermost first:

1. `requestScope()` (so everything below can use `RequestScope`), then `timeout(ms)`.
2. `compress()` then `etag()` on the app, so they wrap every response.
3. Per router: `bodyLimit()` before anything that reads the body, then `cookies()`, then `session()`
   (the session middleware reads and writes the cookie header itself; it does not need `cookies()`,
   but the two compose), then route-level `multipart()` / `sse()` / `stream()`.

What ends up on `ctx`:

| Middleware          | Adds to `ctx`                                                             |
| ------------------- | ------------------------------------------------------------------------- |
| `cookies()`         | `cookies`: a `Cookies` jar                                                |
| `session()`         | `session`: the request's `Session`                                        |
| `i18n({ i18next })` | `t`, `language`, `i18n`                                                   |
| `multipart()`       | `form`: a `MultipartForm`                                                 |
| the rest            | nothing; they change `ctx.response` or the request, or reject the request |

The context types are exported for typing other code: `CookiesContext`, `SessionContext`,
`I18nContext`, `MultipartContext`. A router that expects an app-level `cookies()` declares it as its
input with `new RhythmRouter<CookiesContext>()`, and `mount()` checks at compile time that the app
provides it.

### Mounting a fetch-style handler at a path

A package like Better Auth exposes a `(request) => Response` handler. Mount it at a path with
`fromFetch` and `pathIs`, no adapter needed:

```ts
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { fromFetch } from "@rhythmjs/router/fetch";
import { pathIs } from "@rhythmjs/router/path";

const app = new Rhythm()
  .use(
    mount(
      fromFetch((request) => auth.handler(request)),
      pathIs("/api/auth/**"),
    ),
  )
  .use(mount(api));
```

(`@rhythmjs/http/mount` no longer exists.) App-level middleware registered before these mounts, like
`compress()` or `timeout()`, wraps the fetch handler's response too.

## `@rhythmjs/http/cookies`

Bun's native `Bun.CookieMap` and `Bun.Cookie` behind a `Cookies` jar on the context for reading and
writing.

```ts
import { RhythmRouter } from "@rhythmjs/router";
import { cookies } from "@rhythmjs/http/cookies";

new RhythmRouter().use(cookies()).get("/", (ctx) => {
  ctx.cookies.get("theme"); // string | undefined
  ctx.cookies.set("theme", "dark", { httpOnly: true, sameSite: "lax", maxAge: 3600 });
  ctx.cookies.delete("legacy");
  ctx.text("ok");
});
```

- `ctx.cookies`: `get(name)`, `has(name)`, `getAll()`, `set(name, value, options?)`, and
  `delete(name, options?)` (emits an expired cookie with `Max-Age=0`; pass the same `domain`/`path`
  the cookie was set with). Reads reflect the request's `Cookie` header only, not values set during the
  same request. Multiple `set()` calls emit separate `Set-Cookie` headers. Bun's serialization
  defaults apply: `Path=/` and `SameSite=Lax`.
- `CookieOptions`: Bun's `CookieInit` attributes without `name`/`value`; `domain`, `expires`,
  `httpOnly`, `maxAge`, `path`, `sameSite`, `secure`, `partitioned`.
- The standalone `parseCookies(header)` and `serializeCookie(name, value, options?)` helpers are
  exported too, both on the native primitives.

## `@rhythmjs/http/session`

Cookie-based sessions with a pluggable store.

```ts
import { session } from "@rhythmjs/http/session";

new RhythmRouter()
  .use(session())
  .post("/login", (ctx) => {
    ctx.session.set("user", "ada");
    ctx.text("logged in");
  })
  .get("/me", (ctx) => {
    ctx.text(String(ctx.session.get("user") ?? "anonymous"));
  })
  .post("/logout", (ctx) => {
    ctx.session.destroy();
    ctx.text("logged out");
  });
```

- `ctx.session`: `id`, `get<T>(key)`, `set(key, value)`, `delete(key)`, `regenerate()`, `destroy()`.
  Call `regenerate()` when privileges change (right after login): it issues a new id, carries the data
  over, and invalidates the old id, which stops session fixation.
- Writes happen after the handler returns. The session cookie (`sid` by default; `HttpOnly`,
  `Secure`, `SameSite=Lax`, `Path=/`) is only sent when the session is first written or regenerated;
  a request that only reads sends nothing and stores nothing. `destroy()` deletes the stored session
  and expires the cookie. Unknown or expired session ids get a fresh session; the cookie value is never
  trusted as-is.
- `SessionOptions`: `store` (any object satisfying `SessionStore`, `get(id)` / `set(id, data, maxAge)` /
  `delete(id)`, sync or async; the bundled `memorySessionStore()` by default, suitable for a single
  process), `cookieName`, `maxAge` (seconds, default 86400), `path`, `secure` (default `true`; set
  `false` only for plain-HTTP development, though browsers still accept `Secure` cookies on
  `http://localhost`), `sameSite` (`"strict" | "lax" | "none"`). `memorySessionStore()` sweeps expired
  entries as it writes.
- Exported types: `Session`, `SessionStore`, `SessionData`, `SessionOptions`, `SessionContext`.

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
- Only successful (2xx) string bodies are tagged; a pre-set `ETag` is left alone. Binary and stream
  bodies are never tagged. Matching is an exact comparison against the comma-separated `If-None-Match`
  entries (no `*` handling).

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

- `cacheControl(options)`: sets `Cache-Control` from typed directives (`maxAge`, `sMaxAge`,
  `staleWhileRevalidate`, `staleIfError`, `public`, `private`, `noCache`, `noStore`, `mustRevalidate`,
  `immutable`) unless the handler already set one. Time values must be non-negative integers or it
  throws `RangeError` when you create the middleware. `formatCacheControl(options)` exposes the string
  builder on its own.
- `cache(options)`: caches `200` responses to `GET`/`HEAD` requests and replays them without running
  the handler, with `X-Cache: HIT`/`MISS` and an `Age` header on hits. It never caches responses marked
  `no-store`/`private`, `text/event-stream`, `Vary: *`, responses that carry `Set-Cookie`, stream
  bodies, form bodies, or responses to requests with `Authorization` unless the response opts in with
  `public`, `s-maxage`, or `must-revalidate` (RFC 9111 section 3.5): a shared cache must not replay one
  user's response to another. Requests that carry a `Cookie` header bypass the cache entirely (no
  lookup, no store) unless `cookies: true` is set.

`CacheOptions`:

- `ttl`: seconds an entry stays fresh (default `60`).
- `store`: any object satisfying `CacheStore` (`get(key)`, `set(key, entry, ttl)`, `delete(key)`;
  sync or async, entries are plain `{ status, headers, body, storedAt }` data). Defaults to
  `memoryCacheStore()`, an LRU capped at `maxEntries` (default `1024`) entries of at most
  `maxEntryBytes` (default 1 MiB) each, so unique-URL floods cannot grow memory without bound; back
  it with Redis etc. to share across processes, and invalidate with `store.delete(key)`.
- `keyOf(request)`: cache key (default `METHOD path?query`).
- `vary`: request header names folded into the key (e.g. `["accept-language"]`).
- `cookies`: cache requests that carry a `Cookie` header (default `false`). Enable only when the
  response does not depend on cookies, or fold the relevant cookie into the key with `vary: ["cookie"]`.
- `filter(ctx)`: veto caching per response.

Because a hit replays raw bytes, register `cache()` inside `etag()`/`compress()` if you use them, not
the other way round, so those still run on hits.

## `@rhythmjs/http/compress`

Response compression on Bun's native compressors, with no dependencies. Negotiates `zstd` / `gzip` /
`deflate` against the request's `Accept-Encoding` (respecting `;q=0`): buffered bodies go through
`Bun.zstdCompressSync` / `Bun.gzipSync` synchronously, streams pipe through `CompressionStream`
(which is why a streaming body never picks `zstd`, and `deflate`, zlib-wrapped per RFC 9110,
always streams).

```ts
import { compress } from "@rhythmjs/http/compress";

new RhythmRouter().use(compress()).get("/api/data", (ctx) => {
  ctx.json(bigPayload);
});
```

Options (`CompressOptions`):

- `threshold`: minimum body size in bytes for buffered bodies (default `1024`); streams are always
  compressed since their size is unknown.
- `encodings`: preference order offered to the client (default `["zstd", "gzip", "deflate"]`).
- `filter(contentType)`: replace the default compressible-type check (`text/*` except
  `text/event-stream`, JSON, JavaScript, XML/RSS/Atom/XHTML, SVG, wasm, TTF/OTF fonts).
- It never touches responses that are `204`/`304`, empty, already `Content-Encoding`-ed,
  `text/event-stream` (compressing SSE buffers events), form bodies, or non-compressible types, and it
  appends `Vary: Accept-Encoding` wherever negotiation applies (even when a body is under the
  threshold).

## `@rhythmjs/http/i18n`

[i18next](https://www.i18next.com/) integration: detects the request language, exposes a
request-scoped translator on the context, and sets the `Content-Language` response header. The
middleware is coupled structurally (`I18nInstanceLike`) rather than against i18next's own types:
every instance capability (`cloneInstance`, `getFixedT`, `changeLanguage`, `init`) is
feature-detected at runtime, so it works across i18next versions (optional peer dependency, any
version) and with any compatible instance.

```ts
import i18next from "i18next";
import { i18n } from "@rhythmjs/http/i18n";

await i18next.init({
  supportedLngs: ["en", "de"],
  fallbackLng: "en",
  resources: {
    en: { translation: { greeting: "Hello {{name}}" } },
    de: { translation: { greeting: "Hallo {{name}}" } },
  },
});

new RhythmRouter().use(i18n({ i18next })).get("/greet", (ctx) => {
  ctx.text(ctx.t("greeting", { name: "Ada" })); // "Hallo Ada" for ?lng=de
});
```

- `ctx.t`: the instance's own `t` type bound to the detected language (a real i18next instance
  keeps its full `TFunction` typing); `ctx.language`: the resolved language; `ctx.i18n`: a
  request-scoped clone when the instance supports `cloneInstance` (safe for `changeLanguage` per
  request), otherwise a `getFixedT`-based fallback.
- Detection tries `?lng=` querystring, the `i18next` cookie, then `Accept-Language` (ordered by
  quality, matched exactly or by base language against `supportedLngs`), falling back to
  `fallbackLng`. Both lists default to the instance's own `supportedLngs` / `fallbackLng`. The first
  source that yields a valid candidate wins. Configure via `detection`: `order` (a list of
  `"querystring" | "cookie" | "header" | "path"`; `"path"` reads `/de/...`-style prefixes, with
  `lookupPath` as the segment index, default `0`), `lookupQuerystring`, `lookupCookie`,
  `supportedLanguages`, `fallbackLanguage`. Candidates from any source must look like a language tag
  (`^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,7}$`); anything else is ignored before it reaches i18next or
  the `Content-Language` header.
- `cacheCookie: true` persists the resolved language in the detection cookie when it differs from the
  request's (`cacheCookieMaxAge` seconds, default one year); `contentLanguage: false` disables the
  response header (an existing `Content-Language` is never overwritten). An uninitialized instance is
  initialized on first request.
- The standalone `detectLanguage(request, options?)` and `parseAcceptLanguage(header)` helpers are
  exported too.

## `@rhythmjs/http/sse`

Route middleware that applies the Server-Sent Events response headers. The handler owns the body:
assign any `ReadableStream` of SSE frames, driven by a writer, a generator, an observable bridge, or
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

- Defaults, each applied only if absent after the handler runs:
  `content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`,
  `connection: keep-alive`, `x-accel-buffering: no` (disables nginx proxy buffering). Headers set by
  the handler or by other middleware win over them.
- `SseOptions.headers`: extra headers that override everything, including handler-set values.
- Bun streams `ReadableStream` bodies with backpressure; `ctx.request.signal` aborts on client
  disconnect, so producers can stop cleanly. The body streams after the middleware chain resolves, so
  after-`next()` middleware sees time-to-headers, not the lifetime of the stream.

## `@rhythmjs/http/stream`

Route middleware that applies plain streaming response headers, the non-SSE sibling of
`@rhythmjs/http/sse`. The handler owns the body: assign any `ReadableStream` (progressive text,
NDJSON, LLM tokens, proxied upstream bodies).

```ts
import { stream } from "@rhythmjs/http/stream";

new RhythmRouter().get("/report", stream(), (ctx) => {
  ctx.response.body = upstream.body;
});
```

- Defaults, each applied only if absent after the handler runs:
  `content-type: text/plain; charset=utf-8`, `cache-control: no-cache, no-transform`,
  `connection: keep-alive`, `x-accel-buffering: no`, and `x-content-type-options: nosniff` (stops
  browsers sniffing the stream into another type). Headers set by the handler or by other middleware
  win over them.
- `StreamOptions.headers`: extra headers that override everything, including handler-set values.
- Same streaming model as `sse`: Bun streams `ReadableStream` bodies with backpressure,
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

Downstream errors still propagate as errors; only the deadline produces a 504. The downstream work is
not aborted (its result is discarded), so give long-running upstream calls their own `AbortSignal`.
The deadline covers the handler, not the streaming of a returned body.

## `@rhythmjs/http/body-limit`

Rejects request bodies larger than a byte limit with
`413 { "success": false, "status": 413, "message": "Payload Too Large" }`.

```ts
import { bodyLimit } from "@rhythmjs/http/body-limit";

new RhythmRouter().use(bodyLimit(1024 * 1024)).post("/upload", async (ctx) => {
  ctx.text("stored");
});
```

- With a valid `Content-Length`, the declared size is compared to `maxBytes` and the body is left
  untouched for the handler.
- Without one (chunked uploads), the body stream is counted: reading stops the moment the limit is
  crossed, so it can never buffer more than `maxBytes` plus one chunk. Bodies that pass are
  re-exposed on `ctx.request` already buffered (a replacement `Request`, with `ip` carried over), so
  handlers read them as usual.
- Pair it with Bun's own `maxRequestBodySize` in `Bun.serve` as a hard server-wide cap; this
  middleware gives per-router limits.

## `@rhythmjs/http/multipart`

Parses `multipart/form-data` request bodies once and exposes a `MultipartForm` on the context, with
limits enforced before the handler runs. Uses the runtime's native multipart parser.

```ts
import { multipart } from "@rhythmjs/http/multipart";

new RhythmRouter().post("/upload", multipart({ maxBytes: 10_000_000, maxFiles: 3 }), (ctx) => {
  ctx.form.get("title"); // string | undefined
  ctx.form.file("avatar"); // File | undefined
  ctx.form.files(); // File[]
  ctx.text("stored");
});
```

- `ctx.form`: `get(name)` / `getAll(name)` (string fields), `file(name)` / `files(name?)` (`File`
  entries), and `data` (the raw `FormData`).
- Rejections, all as `{ "success": false, "status": ..., "message": ... }`: `415` for non-multipart
  content types, `400` for a missing or malformed body, `413` when `maxBytes` (total body, enforced
  while reading via `Content-Length` or byte counting), `maxFileSize`, `maxFiles`, or `maxFields` is
  exceeded. `maxBytes` defaults to 10 MiB; pass `Infinity` to lift it. `maxFileSize`, `maxFiles` and
  `maxFields` are checked after the body is parsed, so `maxBytes` is what bounds memory.
- The body is parsed once; downstream middleware and handlers share `ctx.form` instead of re-reading
  the single-use body stream (so do not also read `ctx.request.formData()`). Fields and files are held
  in memory, so keep `maxBytes` as low as your uploads allow; streaming-to-disk uploads are out of
  scope for this module.

## `@rhythmjs/http/request-scope`

Opens a per-request scope (backed by
[`AsyncLocalStorage`](https://nodejs.org/api/async_context.html)) holding the current
`RhythmHttpContext` plus a request-local key-value store, readable anywhere in the call stack (loggers,
database helpers, service functions) without threading `ctx` through every signature.

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

- `requestScope()`: register it before any middleware or handler that uses `RequestScope`. Each request
  gets its own scope; concurrent requests never see each other's context or store. On a router it
  covers that router's routes; on the app it covers everything below it.
- `RequestScope.context<TContext>()`: the current context. Pass your extended context type (e.g.
  `RequestScope.context<RhythmHttpContext & CookiesContext>()`) for typed access to properties added by
  earlier middleware.
- `RequestScope.get(key)` / `set(key, value)` / `has(key)` / `delete(key)`: the request-local store, for
  values that belong to the request but not on the context (request ids, loggers, the authenticated
  user). Keys are strings or symbols. Augment the `RequestScopeStore` interface via declaration
  merging to type your keys.
- `RequestScope.run(context, fn)`: open a scope manually, for tests and non-HTTP entry points that reuse
  request-scoped helpers.
- Bare accessors (`context()`, `get()`, `set()`, `has()`, `delete()`) throw `RequestScopeError` when no
  scope is active; `contextOrNull()` and `isActive()` never throw, for code that runs both inside and
  outside requests.
- Built on `AsyncLocalStorage`, which Bun supports natively; no setup needed.

## Testing

Use [`@rhythmjs/testing`](https://github.com/rhythmjs/testing) (`bun add -D @rhythmjs/testing`) to
exercise these middlewares without sockets: `createTestClient` drives a whole app or router, and
`runHttpMiddleware` runs one middleware in isolation.

```ts
import { expect, test } from "bun:test";
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { createTestClient, runHttpMiddleware } from "@rhythmjs/testing/router";
import { bodyLimit } from "@rhythmjs/http/body-limit";
import { cookies } from "@rhythmjs/http/cookies";
import { session } from "@rhythmjs/http/session";

const router = new RhythmRouter()
  .use(cookies())
  .use(session())
  .post("/login", (ctx) => {
    ctx.session.set("user", "ada");
    ctx.text("ok");
  });

test("login sets the session cookie", async () => {
  const client = createTestClient(new Rhythm().use(mount(router)));
  const res = await client.post("/login");
  expect(res.headers.get("set-cookie")).toContain("sid=");
});

test("rejects large bodies", async () => {
  const { response, nextCalled } = await runHttpMiddleware(
    bodyLimit(10),
    new Request("http://localhost/up", { method: "POST", body: "x".repeat(50) }),
  );
  expect(response.status).toBe(413);
  expect(nextCalled).toBe(false);
});
```
