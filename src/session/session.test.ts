import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { MemoryStore, session, type SessionData, type SessionOptions } from "./session";

const serve = (router: RhythmRouter<any>) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const app = (options?: SessionOptions) =>
  serve(
    new RhythmRouter()
      .use(session(options))
      .get("/read", (ctx) => {
        ctx.response.body = JSON.stringify({ id: ctx.session.id, user: ctx.session.get("user") ?? null });
      })
      .post("/login", (ctx) => {
        ctx.session.set("user", "ada");
        ctx.response.body = "logged in";
      })
      .post("/logout", (ctx) => {
        ctx.session.destroy();
        ctx.response.body = "logged out";
      }),
  );

const sidFrom = (res: Response): string => {
  const header = res.headers.get("set-cookie") ?? "";
  const match = /^sid=([^;]+)/.exec(header);
  if (!match) throw new Error(`no sid cookie in: ${header}`);
  return match[1];
};

describe("session", () => {
  test("writes the session cookie on first use and persists data across requests", async () => {
    const handler = app();
    const login = await handler(new Request("http://localhost/login", { method: "POST" }));

    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^sid=[0-9a-f-]+; Max-Age=86400; Path=\/; HttpOnly; SameSite=Lax$/);

    const read = await handler(new Request("http://localhost/read", { headers: { cookie: `sid=${sidFrom(login)}` } }));
    const body = (await read.json()) as { id: string; user: string | null };

    expect(body.user).toBe("ada");
    expect(body.id).toBe(sidFrom(login));
    expect(read.headers.get("set-cookie")).toBeNull();
  });

  test("does not set a cookie when the session is never written", async () => {
    const res = await app()(new Request("http://localhost/read"));

    expect(res.headers.get("set-cookie")).toBeNull();
    expect(((await res.json()) as { user: string | null }).user).toBeNull();
  });

  test("destroy() deletes the stored session and expires the cookie", async () => {
    const handler = app();
    const login = await handler(new Request("http://localhost/login", { method: "POST" }));
    const sid = sidFrom(login);

    const logout = await handler(
      new Request("http://localhost/logout", { method: "POST", headers: { cookie: `sid=${sid}` } }),
    );
    expect(logout.headers.get("set-cookie")).toBe("sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");

    const read = await handler(new Request("http://localhost/read", { headers: { cookie: `sid=${sid}` } }));
    expect(((await read.json()) as { user: string | null }).user).toBeNull();
  });

  test("an unknown session id gets a fresh session instead of trusting the cookie", async () => {
    const res = await app()(new Request("http://localhost/read", { headers: { cookie: "sid=forged-id" } }));
    const body = (await res.json()) as { id: string };

    expect(body.id).not.toBe("forged-id");
  });

  test("supports a custom cookie name and secure attribute", async () => {
    const res = await app({ cookieName: "app.sess", secure: true, sameSite: "strict", maxAge: 60 })(
      new Request("http://localhost/login", { method: "POST" }),
    );

    expect(res.headers.get("set-cookie")).toMatch(
      /^app\.sess=[0-9a-f-]+; Max-Age=60; Path=\/; HttpOnly; SameSite=Strict; Secure$/,
    );
  });

  test("uses a custom store for reads, writes, and deletes", async () => {
    const calls: string[] = [];
    const backing = new Map<string, SessionData>();
    const store = {
      get: (id: string) => {
        calls.push(`get:${id}`);
        return backing.get(id);
      },
      set: (id: string, data: SessionData) => {
        calls.push(`set:${id}`);
        backing.set(id, data);
      },
      delete: (id: string) => {
        calls.push(`delete:${id}`);
        backing.delete(id);
      },
    };

    const handler = app({ store });
    const login = await handler(new Request("http://localhost/login", { method: "POST" }));
    const sid = sidFrom(login);

    await handler(new Request("http://localhost/logout", { method: "POST", headers: { cookie: `sid=${sid}` } }));

    expect(calls).toEqual([`set:${sid}`, `get:${sid}`, `delete:${sid}`]);
    expect(backing.size).toBe(0);
  });

  test("MemoryStore expires entries after maxAge", () => {
    const store = new MemoryStore();
    store.set("a", { user: "ada" }, 60);
    expect(store.get("a")).toEqual({ user: "ada" });

    store.set("b", { user: "grace" }, -1);
    expect(store.get("b")).toBeUndefined();
  });
});
