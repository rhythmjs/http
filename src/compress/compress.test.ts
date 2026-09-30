import { describe, expect, test } from "bun:test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { compress, type CompressOptions } from "./compress";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const LARGE_TEXT = "rhythm ".repeat(500);

const app = (options?: CompressOptions) =>
  serve(
    new RhythmRouter()
      .use(compress(options))
      .get("/text", (ctx) => {
        ctx.text(LARGE_TEXT);
      })
      .get("/json", (ctx) => {
        ctx.json({ body: LARGE_TEXT });
      })
      .get("/small", (ctx) => {
        ctx.text("tiny");
      })
      .get("/binary", (ctx) => {
        ctx.response.headers.set("content-type", "image/png");
        ctx.response.body = new Uint8Array(4096);
      })
      .get("/encoded", (ctx) => {
        ctx.response.headers.set("content-type", "text/plain");
        ctx.response.headers.set("content-encoding", "br");
        ctx.response.body = LARGE_TEXT;
      })
      .get("/sse", (ctx) => {
        ctx.response.headers.set("content-type", "text/event-stream");
        ctx.response.body = LARGE_TEXT;
      })
      .get("/empty", (ctx) => {
        ctx.response.status = 204;
      })
      .get("/stream", (ctx) => {
        ctx.response.headers.set("content-type", "text/plain");
        ctx.response.body = new Response(LARGE_TEXT).body;
      }),
  );

const get = (path: string, acceptEncoding?: string) =>
  new Request(`http://localhost${path}`, {
    headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
  });

async function decompress(response: Response, encoding: "gzip" | "deflate"): Promise<string> {
  const stream = response.body!.pipeThrough(new DecompressionStream(encoding));
  return new Response(stream).text();
}

describe("compress", () => {
  test("prefers zstd by default and compresses buffered bodies with Bun's native zstd", async () => {
    const res = await app()(new Request("http://localhost/text", { headers: { "accept-encoding": "zstd, gzip" } }));

    expect(res.headers.get("content-encoding")).toBe("zstd");
    const decompressed = Bun.zstdDecompressSync(new Uint8Array(await res.arrayBuffer()));
    expect(new TextDecoder().decode(decompressed)).toBe(LARGE_TEXT);
  });

  test("a streaming body never picks zstd; it falls to gzip via CompressionStream", async () => {
    const streamApp = serve(
      new RhythmRouter().use(compress()).get("/stream", (ctx) => {
        ctx.response.headers.set("content-type", "text/plain");
        ctx.response.body = new Response(LARGE_TEXT).body;
      }),
    );
    const res = await streamApp(
      new Request("http://localhost/stream", { headers: { "accept-encoding": "zstd, gzip" } }),
    );

    expect(res.headers.get("content-encoding")).toBe("gzip");
  });
  test("gzips a large text response and round-trips it", async () => {
    const res = await app()(get("/text", "gzip"));

    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("content-length")).toBeNull();
    expect(await decompress(res, "gzip")).toBe(LARGE_TEXT);
  });

  test("compresses json responses", async () => {
    const res = await app()(get("/json", "gzip, deflate"));

    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(await decompress(res, "gzip"))).toEqual({ body: LARGE_TEXT });
  });

  test("falls back to deflate when gzip is refused", async () => {
    const res = await app()(get("/text", "gzip;q=0, deflate"));

    expect(res.headers.get("content-encoding")).toBe("deflate");
    expect(await decompress(res, "deflate")).toBe(LARGE_TEXT);
  });

  test("passes through without accept-encoding", async () => {
    const res = await app()(get("/text"));

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(LARGE_TEXT);
  });

  test("skips bodies under the threshold but still sets vary", async () => {
    const res = await app()(get("/small", "gzip"));

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(await res.text()).toBe("tiny");
  });

  test("compresses small bodies when the threshold allows it", async () => {
    const res = await app({ threshold: 0 })(get("/small", "gzip"));

    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await decompress(res, "gzip")).toBe("tiny");
  });

  test("skips non-compressible content types", async () => {
    const res = await app()(get("/binary", "gzip"));

    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("a custom filter overrides the default allowlist", async () => {
    const res = await app({ filter: (type) => type.startsWith("image/") })(get("/binary", "gzip"));

    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  test("leaves already-encoded responses alone", async () => {
    const res = await app()(get("/encoded", "gzip"));

    expect(res.headers.get("content-encoding")).toBe("br");
    expect(await res.text()).toBe(LARGE_TEXT);
  });

  test("never compresses server-sent events", async () => {
    const res = await app()(get("/sse", "gzip"));

    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("skips bodyless statuses", async () => {
    const res = await app()(get("/empty", "gzip"));

    expect(res.status).toBe(204);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("compresses streaming bodies", async () => {
    const res = await app()(get("/stream", "gzip"));

    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await decompress(res, "gzip")).toBe(LARGE_TEXT);
  });

  test("respects the configured encoding preference order", async () => {
    const res = await app({ encodings: ["deflate", "gzip"] })(get("/text", "gzip, deflate"));

    expect(res.headers.get("content-encoding")).toBe("deflate");
    expect(await decompress(res, "deflate")).toBe(LARGE_TEXT);
  });
});
