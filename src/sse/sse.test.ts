import { describe, expect, test } from "bun:test";
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { sse } from "./sse";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm().use(mount(router)));

const streamOf = (...frames: string[]) => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
};

describe("sse", () => {
  test("applies the event-stream headers around a manual stream body", async () => {
    const app = serve(
      new RhythmRouter().get("/events", sse(), (ctx) => {
        ctx.response.body = streamOf("data: one\n\n", "data: two\n\n");
      }),
    );

    const res = await app(new Request("http://localhost/events"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
  });

  test("keeps headers set by the handler", async () => {
    const app = serve(
      new RhythmRouter().get("/events", sse(), (ctx) => {
        ctx.response.headers.set("cache-control", "private, no-cache");
        ctx.response.body = streamOf("data: hi\n\n");
      }),
    );

    const res = await app(new Request("http://localhost/events"));

    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  });

  test("keeps headers set by other middleware", async () => {
    const app = serve(
      new RhythmRouter()
        .use(async (ctx, next) => {
          await next();
          ctx.response.headers.set("access-control-allow-origin", "*");
        })
        .get("/events", sse(), (ctx) => {
          ctx.response.body = streamOf("data: hi\n\n");
        }),
    );

    const res = await app(new Request("http://localhost/events"));

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  });

  test("options.headers override both defaults and handler headers", async () => {
    const app = serve(
      new RhythmRouter().get("/events", sse({ headers: { "cache-control": "no-store", "x-custom": "1" } }), (ctx) => {
        ctx.response.headers.set("cache-control", "private");
        ctx.response.body = streamOf("data: hi\n\n");
      }),
    );

    const res = await app(new Request("http://localhost/events"));

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-custom")).toBe("1");
  });

  test("supports a handler that drives its own generator", async () => {
    const encoder = new TextEncoder();
    const app = serve(
      new RhythmRouter().get("/events", sse(), (ctx) => {
        const it = (function* () {
          yield "data: a\n\n";
          yield "data: b\n\n";
        })();
        ctx.response.body = new ReadableStream<Uint8Array>({
          pull(controller) {
            const { done, value } = it.next();
            if (done) controller.close();
            else controller.enqueue(encoder.encode(value));
          },
        });
      }),
    );

    const res = await app(new Request("http://localhost/events"));

    expect(await res.text()).toBe("data: a\n\ndata: b\n\n");
  });
});
