import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/adapters/bun";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { cookies, parseCookies, serializeCookie } from "./cookies";

const serve = (router: RhythmRouter<any>) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

describe("cookies", () => {
  test("parses incoming cookies and exposes them on ctx.cookies", async () => {
    const app = serve(
      new RhythmRouter().use(cookies()).get("/", (ctx) => {
        ctx.response.body = JSON.stringify({ theme: ctx.cookies.get("theme"), all: ctx.cookies.getAll() });
      }),
    );

    const res = await app(new Request("http://localhost/", { headers: { cookie: "theme=dark; lang=en%20US" } }));

    expect(await res.json()).toEqual({ theme: "dark", all: { theme: "dark", lang: "en US" } });
  });

  test("returns undefined for a missing cookie", async () => {
    const app = serve(
      new RhythmRouter().use(cookies()).get("/", (ctx) => {
        ctx.response.body = String(ctx.cookies.get("missing"));
      }),
    );

    const res = await app(new Request("http://localhost/"));

    expect(await res.text()).toBe("undefined");
  });

  test("sets a cookie with a default path and the given attributes", async () => {
    const app = serve(
      new RhythmRouter().use(cookies()).get("/", (ctx) => {
        ctx.cookies.set("theme", "dark mode", { httpOnly: true, sameSite: "lax", maxAge: 3600 });
        ctx.response.body = "ok";
      }),
    );

    const res = await app(new Request("http://localhost/"));

    expect(res.headers.get("set-cookie")).toBe("theme=dark%20mode; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax");
  });

  test("sets multiple cookies as separate set-cookie headers", async () => {
    const app = serve(
      new RhythmRouter().use(cookies()).get("/", (ctx) => {
        ctx.cookies.set("a", "1");
        ctx.cookies.set("b", "2");
        ctx.response.body = "ok";
      }),
    );

    const res = await app(new Request("http://localhost/"));

    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  test("delete() expires the cookie", async () => {
    const app = serve(
      new RhythmRouter().use(cookies()).get("/", (ctx) => {
        ctx.cookies.delete("theme");
        ctx.response.body = "ok";
      }),
    );

    const res = await app(new Request("http://localhost/"));

    expect(res.headers.get("set-cookie")).toBe("theme=; Max-Age=0; Path=/");
  });

  test("parseCookies and serializeCookie round-trip values and attributes", () => {
    expect(parseCookies('a=1; b="quoted"; malformed; =empty')).toEqual({ a: "1", b: "quoted" });
    expect(parseCookies(null)).toEqual({});
    expect(
      serializeCookie("token", "a b", {
        domain: "example.com",
        path: "/app",
        expires: new Date("2027-01-01T00:00:00Z"),
        secure: true,
        sameSite: "none",
      }),
    ).toBe("token=a%20b; Domain=example.com; Path=/app; Expires=Fri, 01 Jan 2027 00:00:00 GMT; Secure; SameSite=None");
  });
});
