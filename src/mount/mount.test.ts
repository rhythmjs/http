import { describe, expect, test } from "bun:test";
import { Rhythm, mount as mountRouter } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/context";
import { mount } from "./mount";

const downstream = new RhythmRouter().get("/api/users", (ctx) => {
  ctx.response.body = "users";
});

const serve = (...middleware: ReturnType<typeof mount>[]) => {
  let app = new Rhythm<{}, RhythmHttpContext>();
  for (const entry of middleware) app = app.use(entry);
  return toFetchHandler(app.use(mountRouter(downstream)));
};

const get = (handler: (request: Request) => Promise<Response>, path: string) =>
  handler(new Request(`http://localhost${path}`));

describe("mount: rou3 path conventions", () => {
  const catchAll = serve(mount("/api/auth/**", (ctx) => new Response(`auth:${new URL(ctx.request.url).pathname}`)));

  test("** is the catch-all: everything beneath the prefix, at any depth", async () => {
    expect(await (await get(catchAll, "/api/auth/sign-in")).text()).toBe("auth:/api/auth/sign-in");
    expect(await (await get(catchAll, "/api/auth/sign-up/email")).text()).toBe("auth:/api/auth/sign-up/email");
  });

  test("** also matches the prefix itself, with or without a trailing slash", async () => {
    expect(await (await get(catchAll, "/api/auth")).text()).toBe("auth:/api/auth");
    expect(await (await get(catchAll, "/api/auth/")).text()).toBe("auth:/api/auth/");
  });

  test("a sibling that merely starts with the prefix does not match", async () => {
    expect(await (await get(catchAll, "/api/authx")).text()).toBe("Not Found");
  });

  test("other requests pass through to the rest of the app", async () => {
    expect(await (await get(catchAll, "/api/users")).text()).toBe("users");
  });

  test("* matches a single segment only, not deeper paths", async () => {
    const single = serve(mount("/api/auth/*", () => new Response("single")));
    expect(await (await get(single, "/api/auth/sign-in")).text()).toBe("single");
    expect(await (await get(single, "/api/auth/sign-up/email")).text()).toBe("Not Found");
  });

  test("a static path matches that path only", async () => {
    const exact = serve(mount("/api/ping", () => new Response("pong")));
    expect(await (await get(exact, "/api/ping")).text()).toBe("pong");
    expect(await (await get(exact, "/api/ping/more")).text()).toBe("Not Found");
  });

  test(":name matches one segment, and can be followed by a catch-all", async () => {
    const named = serve(mount("/hooks/:id/**", (ctx) => new Response(new URL(ctx.request.url).pathname)));
    expect(await (await get(named, "/hooks/7/deliver/now")).text()).toBe("/hooks/7/deliver/now");
    expect(await (await get(named, "/other/7")).text()).toBe("Not Found");
  });

  test("/** mounts the whole app", async () => {
    const all = serve(mount("/**", () => new Response("everything")));
    expect(await (await get(all, "/api/users")).text()).toBe("everything");
    expect(await (await get(all, "/")).text()).toBe("everything");
  });

  test("the method is not part of the match", async () => {
    const handler = serve(mount("/api/auth/**", (ctx) => new Response(ctx.request.method)));
    const post = await handler(new Request("http://localhost/api/auth/sign-in", { method: "POST" }));
    expect(await post.text()).toBe("POST");
    const del = await handler(new Request("http://localhost/api/auth/session", { method: "DELETE" }));
    expect(await del.text()).toBe("DELETE");
  });

  test("rejects a path that does not start with a slash", () => {
    expect(() => mount("api/auth/**", () => undefined)).toThrow(TypeError);
  });
});

describe("mount: the returned Response", () => {
  test("its status, status text, headers and body become the response", async () => {
    const handler = serve(
      mount("/hook", () => new Response("created", { status: 201, statusText: "Created", headers: { "x-id": "7" } })),
    );
    const response = await get(handler, "/hook");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-id")).toBe("7");
    expect(await response.text()).toBe("created");
  });

  test("every Set-Cookie header survives, not just the last", async () => {
    const handler = serve(
      mount("/login", () => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response(null, { status: 204, headers });
      }),
    );
    const response = await get(handler, "/login");
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  test("a streamed body is passed on as a stream", async () => {
    const handler = serve(
      mount("/stream", () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("one,"));
              controller.enqueue(encoder.encode("two"));
              controller.close();
            },
          }),
        );
      }),
    );
    expect(await (await get(handler, "/stream")).text()).toBe("one,two");
  });

  test("an async handler is awaited", async () => {
    const handler = serve(
      mount("/slow", async () => {
        await Bun.sleep(5);
        return new Response("done");
      }),
    );
    expect(await (await get(handler, "/slow")).text()).toBe("done");
  });

  test("headers set by earlier middleware are kept unless the Response sets them again", async () => {
    const early = (ctx: RhythmHttpContext, next: () => Promise<unknown>) => {
      ctx.response.headers.set("x-early", "yes");
      ctx.response.headers.set("x-override", "early");
      return next().then(() => undefined);
    };
    const app = new Rhythm<{}, RhythmHttpContext>()
      .use(early)
      .use(mount("/m", () => new Response("ok", { headers: { "x-override": "mounted" } })));
    const response = await get(toFetchHandler(app), "/m");
    expect(response.headers.get("x-early")).toBe("yes");
    expect(response.headers.get("x-override")).toBe("mounted");
  });

  test("the handler is not run, and the chain continues, for a path that does not match", async () => {
    let calls = 0;
    const handler = serve(
      mount("/only-here", () => {
        calls++;
        return new Response("no");
      }),
    );
    expect(await (await get(handler, "/api/users")).text()).toBe("users");
    expect(calls).toBe(0);
  });
});

describe("mount: used as a plain middleware", () => {
  test("a handler that returns nothing decides for itself, and may call next()", async () => {
    const handler = serve(
      mount("/api/**", async (ctx, next) => {
        ctx.response.headers.set("x-mounted", "true");
        await next();
      }),
    );
    const response = await get(handler, "/api/users");
    expect(response.headers.get("x-mounted")).toBe("true");
    expect(await response.text()).toBe("users");
  });

  test("a handler that writes ctx.response and returns nothing short-circuits like any middleware", async () => {
    const handler = serve(
      mount("/api/users", (ctx) => {
        ctx.response.status = 418;
        ctx.response.body = "teapot";
      }),
    );
    const response = await get(handler, "/api/users");
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("teapot");
  });

  test("errors thrown by the handler propagate", async () => {
    const handler = serve(
      mount("/boom", () => {
        throw new Error("nope");
      }),
    );
    await expect(get(handler, "/boom")).rejects.toThrow("nope");
  });
});
