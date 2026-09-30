import { describe, expect, test } from "bun:test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { bodyLimit } from "./body-limit";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const app = (maxBytes: number) =>
  serve(
    new RhythmRouter().use(bodyLimit(maxBytes)).post("/upload", async (ctx) => {
      ctx.response.body = `received ${(await ctx.request.clone().arrayBuffer()).byteLength} bytes`;
    }),
  );

describe("bodyLimit", () => {
  test("lets requests under the limit through", async () => {
    const res = await app(1024)(new Request("http://localhost/upload", { method: "POST", body: "small" }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("received 5 bytes");
  });

  test("rejects requests over the limit with 413", async () => {
    const res = await app(10)(new Request("http://localhost/upload", { method: "POST", body: "x".repeat(64) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ success: false, status: 413, message: "Payload Too Large" });
  });

  test("rejects based on the content-length header without reading the body", async () => {
    const res = await app(10)(
      new Request("http://localhost/upload", {
        method: "POST",
        body: "irrelevant",
        headers: { "content-length": "9999" },
      }),
    );

    expect(res.status).toBe(413);
  });

  test("aborts a streaming body at the limit instead of buffering it", async () => {
    let produced = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1024;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const res = await app(4096)(
      new Request("http://localhost/upload", { method: "POST", body: endless, duplex: "half" } as RequestInit),
    );

    expect(res.status).toBe(413);
    expect(produced).toBeLessThanOrEqual(4096 + 2048);
  });

  test("enforces the limit when content-length is malformed", async () => {
    const res = await app(10)(
      new Request("http://localhost/upload", {
        method: "POST",
        body: "x".repeat(64),
        headers: { "content-length": "not-a-number" },
      }),
    );

    expect(res.status).toBe(413);
  });

  test("preserves request.ip on the replacement request", async () => {
    const handler = serve(
      new RhythmRouter().use(bodyLimit(1024)).post("/upload", (ctx) => {
        ctx.response.body = `ip ${(ctx.request as { ip?: string }).ip}`;
      }),
    );
    const request = new Request("http://localhost/upload", { method: "POST", body: "small" });
    (request as unknown as { ip?: string }).ip = "10.0.0.1";

    const res = await handler(request);

    expect(await res.text()).toBe("ip 10.0.0.1");
  });

  test("lets bodyless requests through regardless of the limit", async () => {
    const handler = serve(
      new RhythmRouter().use(bodyLimit(0)).get("/ping", (ctx) => {
        ctx.response.body = "pong";
      }),
    );

    const res = await handler(new Request("http://localhost/ping"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });
});
