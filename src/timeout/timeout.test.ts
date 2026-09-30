import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { timeout } from "./timeout";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("timeout", () => {
  test("responds 504 when downstream exceeds the deadline", async () => {
    const app = serve(
      new RhythmRouter().use(timeout(20)).get("/slow", async (ctx) => {
        await sleep(200);
        ctx.response.body = "too late";
      }),
    );

    const res = await app(new Request("http://localhost/slow"));

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ success: false, status: 504, message: "Gateway Timeout" });
  });

  test("passes fast responses through untouched", async () => {
    const app = serve(
      new RhythmRouter().use(timeout(200)).get("/fast", (ctx) => {
        ctx.response.body = "quick";
      }),
    );

    const res = await app(new Request("http://localhost/fast"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("quick");
  });

  test("propagates downstream errors instead of converting them to 504", async () => {
    const app = serve(
      new RhythmRouter().use(timeout(200)).get("/boom", () => {
        throw new Error("boom");
      }),
    );

    await expect(app(new Request("http://localhost/boom"))).rejects.toThrow("boom");
  });

  test("applies per request, not once per middleware instance", async () => {
    const app = serve(
      new RhythmRouter().use(timeout(50)).get("/ok", async (ctx) => {
        await sleep(5);
        ctx.response.body = "ok";
      }),
    );

    const first = await app(new Request("http://localhost/ok"));
    const second = await app(new Request("http://localhost/ok"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
