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
- `SessionOptions` — `store` (any `SessionStore` implementation; the bundled `MemoryStore` by default,
  suitable for a single process), `cookieName`, `maxAge` (seconds, default 86400), `path`, `secure`,
  `sameSite`.

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
