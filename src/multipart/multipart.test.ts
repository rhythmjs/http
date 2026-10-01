import { describe, expect, test } from "bun:test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { multipart, type MultipartOptions } from "./multipart";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const upload = (form: FormData) => new Request("http://localhost/upload", { method: "POST", body: form });

const echoApp = (options: MultipartOptions = {}) =>
  serve(
    new RhythmRouter().post("/upload", multipart(options), (ctx) => {
      ctx.json({
        title: ctx.form.get("title"),
        tags: ctx.form.getAll("tag"),
        fileName: ctx.form.file("file")?.name,
        fileCount: ctx.form.files().length,
      });
    }),
  );

describe("multipart", () => {
  test("parses fields and files onto ctx.form", async () => {
    const form = new FormData();
    form.append("title", "hello");
    form.append("tag", "a");
    form.append("tag", "b");
    form.append("file", new File(["file content"], "notes.txt", { type: "text/plain" }));

    const res = await echoApp()(upload(form));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "hello", tags: ["a", "b"], fileName: "notes.txt", fileCount: 1 });
  });

  test("exposes file contents as real File objects", async () => {
    let text: string | undefined;
    const app = serve(
      new RhythmRouter().post("/upload", multipart(), async (ctx) => {
        text = await ctx.form.file("file")?.text();
        ctx.text("ok");
      }),
    );
    const form = new FormData();
    form.append("file", new File(["binary\u0000safe"], "a.bin", { type: "application/octet-stream" }));

    const res = await app(upload(form));

    expect(res.status).toBe(200);
    expect(text).toBe("binary\u0000safe");
  });

  test("applies a 10 MiB default body limit", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(11 * 1024 * 1024)], "big.bin"));

    const res = await echoApp()(upload(form));

    expect(res.status).toBe(413);
  });

  test("lifts the body limit when maxBytes is Infinity", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(11 * 1024 * 1024)], "big.bin"));

    const res = await echoApp({ maxBytes: Infinity })(upload(form));

    expect(res.status).toBe(200);
  });

  test("rejects non-multipart requests with 415", async () => {
    const res = await echoApp()(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ success: false, status: 415, message: "Unsupported Media Type" });
  });

  test("rejects a missing body with 400", async () => {
    const res = await echoApp()(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      }),
    );

    expect(res.status).toBe(400);
  });

  test("rejects a malformed body with 400", async () => {
    const res = await echoApp()(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "not multipart at all",
      }),
    );

    expect(res.status).toBe(400);
  });

  test("rejects bodies over maxBytes with 413", async () => {
    const form = new FormData();
    form.append("file", new File(["x".repeat(1000)], "big.txt"));

    const res = await echoApp({ maxBytes: 100 })(upload(form));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ success: false, status: 413, message: "Payload Too Large" });
  });

  test("parses successfully when under maxBytes", async () => {
    const form = new FormData();
    form.append("title", "small");

    const res = await echoApp({ maxBytes: 10_000 })(upload(form));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe("small");
  });

  test("rejects a file over maxFileSize with 413", async () => {
    const form = new FormData();
    form.append("file", new File(["x".repeat(200)], "big.txt"));

    const res = await echoApp({ maxFileSize: 100 })(upload(form));

    expect(res.status).toBe(413);
  });

  test("rejects too many files with 413", async () => {
    const form = new FormData();
    form.append("a", new File(["1"], "a.txt"));
    form.append("b", new File(["2"], "b.txt"));

    const res = await echoApp({ maxFiles: 1 })(upload(form));

    expect(res.status).toBe(413);
  });

  test("rejects too many fields with 413", async () => {
    const form = new FormData();
    form.append("a", "1");
    form.append("b", "2");
    form.append("c", "3");

    const res = await echoApp({ maxFields: 2 })(upload(form));

    expect(res.status).toBe(413);
  });
});
