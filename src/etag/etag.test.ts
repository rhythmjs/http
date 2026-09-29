import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/adapters/bun";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { etag, type EtagOptions } from "./etag";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.routes()));

const app = (body: string, options?: EtagOptions) =>
  serve(
    new RhythmRouter().use(etag(options)).get("/", (ctx) => {
      ctx.response.body = body;
    }),
  );

describe("etag", () => {
  test("sets a strong etag derived from the body", async () => {
    const first = await app("hello")(new Request("http://localhost/"));
    const second = await app("hello")(new Request("http://localhost/"));

    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(second.headers.get("etag")).toBe(tag);
  });

  test("different bodies produce different etags", async () => {
    const a = await app("aaa")(new Request("http://localhost/"));
    const b = await app("bbb")(new Request("http://localhost/"));

    expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
  });

  test("answers 304 with an empty body when if-none-match matches", async () => {
    const handler = app("cached content");
    const first = await handler(new Request("http://localhost/"));
    const tag = first.headers.get("etag") as string;

    const revalidated = await handler(new Request("http://localhost/", { headers: { "if-none-match": tag } }));

    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("etag")).toBe(tag);
  });

  test("returns the full body when if-none-match does not match", async () => {
    const res = await app("fresh")(new Request("http://localhost/", { headers: { "if-none-match": '"stale"' } }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fresh");
  });

  test("weak option prefixes the tag with W/", async () => {
    const res = await app("hello", { weak: true })(new Request("http://localhost/"));

    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{40}"$/);
  });

  test("skips non-2xx responses, non-string bodies, and pre-set etags", async () => {
    const notFound = serve(
      new RhythmRouter().use(etag()).get("/", (ctx) => {
        ctx.response.status = 404;
        ctx.response.body = "missing";
      }),
    );
    expect((await notFound(new Request("http://localhost/"))).headers.get("etag")).toBeNull();

    const empty = serve(
      new RhythmRouter().use(etag()).get("/", (ctx) => {
        ctx.response.body = null;
      }),
    );
    expect((await empty(new Request("http://localhost/"))).headers.get("etag")).toBeNull();

    const preset = serve(
      new RhythmRouter().use(etag()).get("/", (ctx) => {
        ctx.response.headers.set("etag", '"custom"');
        ctx.response.body = "body";
      }),
    );
    expect((await preset(new Request("http://localhost/"))).headers.get("etag")).toBe('"custom"');
  });
});
