import { describe, expect, test } from "bun:test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import {
  cache,
  cacheControl,
  formatCacheControl,
  memoryCacheStore,
  type CacheEntry,
  type CacheOptions,
  type CacheStore,
} from "./cache";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const counterApp = (options?: CacheOptions) => {
  let hits = 0;
  const handler = serve(
    new RhythmRouter()
      .use(cache(options))
      .get("/data", (ctx) => {
        hits += 1;
        ctx.json({ hits });
      })
      .post("/data", (ctx) => {
        hits += 1;
        ctx.json({ hits });
      })
      .get("/missing", (ctx) => {
        ctx.error(404);
      })
      .get("/personal", (ctx) => {
        hits += 1;
        ctx.response.headers.set("cache-control", "private, max-age=60");
        ctx.json({ hits });
      })
      .get("/events", (ctx) => {
        hits += 1;
        ctx.response.headers.set("content-type", "text/event-stream");
        ctx.response.body = "data: x\n\n";
      })
      .get("/login", (ctx) => {
        hits += 1;
        ctx.response.headers.set("set-cookie", `sid=${hits}; HttpOnly`);
        ctx.json({ hits });
      })
      .get("/shared", (ctx) => {
        hits += 1;
        ctx.response.headers.set("cache-control", "public, max-age=60");
        ctx.json({ hits });
      })
      .get("/stream", (ctx) => {
        hits += 1;
        ctx.response.body = new Response("streamed").body;
      }),
  );
  return { handler, handled: () => hits };
};

const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers });

describe("cache", () => {
  test("serves the second request from the store", async () => {
    const { handler, handled } = counterApp();

    const miss = await handler(get("/data"));
    expect(miss.headers.get("x-cache")).toBe("MISS");
    expect(await miss.json()).toEqual({ hits: 1 });

    const hit = await handler(get("/data"));
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("age")).toBe("0");
    expect(await hit.json()).toEqual({ hits: 1 });
    expect(handled()).toBe(1);
  });

  test("expires entries after the ttl", async () => {
    const { handler, handled } = counterApp({ ttl: 0.05 });

    await handler(get("/data"));
    await sleep(70);
    const res = await handler(get("/data"));

    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(handled()).toBe(2);
  });

  test("does not cache non-GET requests", async () => {
    const { handler, handled } = counterApp();

    await handler(new Request("http://localhost/data", { method: "POST" }));
    await handler(new Request("http://localhost/data", { method: "POST" }));

    expect(handled()).toBe(2);
  });

  test("does not cache non-200 responses", async () => {
    const { handler } = counterApp();

    await handler(get("/missing"));
    const res = await handler(get("/missing"));

    expect(res.status).toBe(404);
    expect(res.headers.get("x-cache")).toBe("MISS");
  });

  test("respects no-store and private response directives", async () => {
    const { handler, handled } = counterApp();

    await handler(get("/personal"));
    await handler(get("/personal"));

    expect(handled()).toBe(2);
  });

  test("never caches server-sent events", async () => {
    const { handler, handled } = counterApp();

    await handler(get("/events"));
    await handler(get("/events"));

    expect(handled()).toBe(2);
  });

  test("never caches responses that set cookies", async () => {
    const { handler, handled } = counterApp();

    const first = await handler(get("/login"));
    const second = await handler(get("/login"));

    expect(first.headers.get("set-cookie")).toBe("sid=1; HttpOnly");
    expect(second.headers.get("set-cookie")).toBe("sid=2; HttpOnly");
    expect(second.headers.get("x-cache")).toBe("MISS");
    expect(handled()).toBe(2);
  });

  test("does not cache authorized requests unless the response opts in", async () => {
    const { handler, handled } = counterApp();

    await handler(get("/data", { authorization: "Bearer token" }));
    const res = await handler(get("/data", { authorization: "Bearer token" }));

    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(handled()).toBe(2);
  });

  test("bypasses the cache for requests that carry cookies", async () => {
    const { handler, handled } = counterApp();

    await handler(get("/data"));
    const withCookie = await handler(get("/data", { cookie: "sid=user-a" }));
    await handler(get("/data", { cookie: "sid=user-a" }));

    expect(withCookie.headers.get("x-cache")).toBeNull();
    expect(handled()).toBe(3);
  });

  test("caches requests that carry cookies when cookies is enabled", async () => {
    const { handler, handled } = counterApp({ cookies: true });

    await handler(get("/data", { cookie: "sid=user-a" }));
    const res = await handler(get("/data", { cookie: "sid=user-b" }));

    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(handled()).toBe(1);
  });

  test("caches authorized requests when the response is explicitly public", async () => {
    const { handler, handled } = counterApp();

    await handler(get("/shared", { authorization: "Bearer token" }));
    const res = await handler(get("/shared", { authorization: "Bearer token" }));

    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(handled()).toBe(1);
  });

  test("passes streamed bodies through without caching them", async () => {
    const { handler, handled } = counterApp();

    const first = await handler(get("/stream"));
    expect(await first.text()).toBe("streamed");

    const second = await handler(get("/stream"));
    expect(await second.text()).toBe("streamed");
    expect(second.headers.get("x-cache")).toBe("MISS");
    expect(handled()).toBe(2);
  });

  test("vary splits entries by the named request headers", async () => {
    const { handler, handled } = counterApp({ vary: ["accept-language"] });

    await handler(get("/data", { "accept-language": "en" }));
    await handler(get("/data", { "accept-language": "de" }));
    const en = await handler(get("/data", { "accept-language": "en" }));

    expect(en.headers.get("x-cache")).toBe("HIT");
    expect(handled()).toBe(2);
  });

  test("uses a custom key generator", async () => {
    const { handler, handled } = counterApp({ keyOf: () => "everything" });

    await handler(get("/data"));
    const res = await handler(get("/missing"));

    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(await res.json()).toEqual({ hits: 1 });
    expect(handled()).toBe(1);
  });

  test("filter can veto caching", async () => {
    const { handler, handled } = counterApp({ filter: () => false });

    await handler(get("/data"));
    await handler(get("/data"));

    expect(handled()).toBe(2);
  });

  test("delegates to a plain-object store", async () => {
    const entries = new Map<string, CacheEntry>();
    const store: CacheStore = {
      get: (key) => entries.get(key),
      set: (key, entry) => void entries.set(key, entry),
      delete: (key) => void entries.delete(key),
    };
    const { handler } = counterApp({ store });

    await handler(get("/data"));
    expect([...entries.keys()]).toEqual(["GET /data"]);

    const hit = await handler(get("/data"));
    expect(hit.headers.get("x-cache")).toBe("HIT");
  });
});

describe("memoryCacheStore", () => {
  test("stores, expires, and deletes entries", async () => {
    const store = memoryCacheStore();
    const entry: CacheEntry = { status: 200, headers: [], body: new Uint8Array([1]), storedAt: Date.now() };

    await store.set("a", entry, 60);
    expect(await store.get("a")).toEqual(entry);

    await store.delete("a");
    expect(await store.get("a")).toBeUndefined();

    await store.set("b", entry, 0.03);
    await sleep(50);
    expect(await store.get("b")).toBeUndefined();
  });

  test("evicts the least recently used entry at maxEntries", async () => {
    const store = memoryCacheStore({ maxEntries: 2 });
    const entry: CacheEntry = { status: 200, headers: [], body: new Uint8Array([1]), storedAt: Date.now() };

    await store.set("a", entry, 60);
    await store.set("b", entry, 60);
    await store.get("a");
    await store.set("c", entry, 60);

    expect(await store.get("a")).toEqual(entry);
    expect(await store.get("b")).toBeUndefined();
    expect(await store.get("c")).toEqual(entry);
  });

  test("refuses entries larger than maxEntryBytes", async () => {
    const store = memoryCacheStore({ maxEntryBytes: 4 });
    const entry: CacheEntry = { status: 200, headers: [], body: new Uint8Array(5), storedAt: Date.now() };

    await store.set("big", entry, 60);
    expect(await store.get("big")).toBeUndefined();
  });
});

describe("cacheControl", () => {
  test("formats directives", () => {
    expect(formatCacheControl({ public: true, maxAge: 300, staleWhileRevalidate: 60, immutable: true })).toBe(
      "public, max-age=300, stale-while-revalidate=60, immutable",
    );
    expect(formatCacheControl({ private: true, noStore: true })).toBe("private, no-store");
  });

  test("sets the header unless the handler already did", async () => {
    const handler = serve(
      new RhythmRouter()
        .use(cacheControl({ public: true, maxAge: 300 }))
        .get("/default", (ctx) => {
          ctx.text("ok");
        })
        .get("/own", (ctx) => {
          ctx.response.headers.set("cache-control", "no-store");
          ctx.text("ok");
        }),
    );

    expect((await handler(get("/default"))).headers.get("cache-control")).toBe("public, max-age=300");
    expect((await handler(get("/own"))).headers.get("cache-control")).toBe("no-store");
  });
});
