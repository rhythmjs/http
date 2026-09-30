import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { stream } from "./stream";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const streamOf = (...chunks: string[]) => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

describe("stream", () => {
  test("applies the plain streaming headers around a stream body", async () => {
    const app = serve(
      new RhythmRouter().get("/text", stream(), (ctx) => {
        ctx.response.body = streamOf("one ", "two");
      }),
    );

    const res = await app(new Request("http://localhost/text"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("one two");
  });

  test("keeps a content-type set by the handler", async () => {
    const app = serve(
      new RhythmRouter().get("/ndjson", stream(), (ctx) => {
        ctx.response.headers.set("content-type", "application/x-ndjson");
        ctx.response.body = streamOf('{"n":1}\n');
      }),
    );

    const res = await app(new Request("http://localhost/ndjson"));

    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  });

  test("keeps headers set by other middleware", async () => {
    const app = serve(
      new RhythmRouter()
        .use(async (ctx, next) => {
          await next();
          ctx.response.headers.set("cache-control", "public, max-age=60");
        })
        .get("/text", stream(), (ctx) => {
          ctx.response.body = streamOf("hi");
        }),
    );

    const res = await app(new Request("http://localhost/text"));

    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("options.headers override both defaults and handler headers", async () => {
    const app = serve(
      new RhythmRouter().get("/text", stream({ headers: { "content-type": "text/html", "x-custom": "1" } }), (ctx) => {
        ctx.response.headers.set("content-type", "text/plain");
        ctx.response.body = streamOf("<p>hi</p>");
      }),
    );

    const res = await app(new Request("http://localhost/text"));

    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("x-custom")).toBe("1");
  });
});
