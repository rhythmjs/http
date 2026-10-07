import { describe, expect, test } from "bun:test";
import { Rhythm, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { createHttpContext, type RhythmHttpContext } from "@rhythmjs/router/context";
import { RequestScope, RequestScopeError, requestScope } from "./request-scope";

declare module "./request-scope" {
  interface RequestScopeStore {
    requestId: string;
  }
}

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm().use(mount(router)));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("requestScope", () => {
  test("makes the context reachable in helpers called from a handler", async () => {
    const currentPath = () => new URL(RequestScope.context().request.url).pathname;

    const app = serve(
      new RhythmRouter().use(requestScope()).get("/where", (ctx) => {
        ctx.response.body = currentPath();
      }),
    );

    const res = await app(new Request("http://localhost/where"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/where");
  });

  test("survives awaits inside the handler", async () => {
    const app = serve(
      new RhythmRouter().use(requestScope()).get("/async", async (ctx) => {
        await sleep(10);
        ctx.response.body = RequestScope.context().request.method;
      }),
    );

    const res = await app(new Request("http://localhost/async"));

    expect(await res.text()).toBe("GET");
  });

  test("isolates the context between concurrent requests", async () => {
    const app = serve(
      new RhythmRouter().use(requestScope()).get("/echo/:id", async (ctx) => {
        await sleep(Math.random() * 20);
        ctx.response.body = new URL(RequestScope.context().request.url).pathname;
      }),
    );

    const paths = ["/echo/a", "/echo/b", "/echo/c", "/echo/d"];
    const responses = await Promise.all(paths.map((path) => app(new Request(`http://localhost${path}`))));
    const bodies = await Promise.all(responses.map((res) => res.text()));

    expect(bodies).toEqual(paths);
  });

  test("isolates the store between concurrent requests", async () => {
    const app = serve(
      new RhythmRouter().use(requestScope()).get("/tag/:id", async (ctx) => {
        RequestScope.set("requestId", new URL(ctx.request.url).pathname);
        await sleep(Math.random() * 20);
        ctx.response.body = RequestScope.get("requestId") ?? "lost";
      }),
    );

    const paths = ["/tag/a", "/tag/b", "/tag/c", "/tag/d"];
    const responses = await Promise.all(paths.map((path) => app(new Request(`http://localhost${path}`))));
    const bodies = await Promise.all(responses.map((res) => res.text()));

    expect(bodies).toEqual(paths);
  });

  test("store values set by earlier middleware are visible downstream, and gone next request", async () => {
    const app = serve(
      new RhythmRouter()
        .use(requestScope())
        .use(async (_ctx, next) => {
          if (!RequestScope.has("requestId")) RequestScope.set("requestId", "fresh");
          await next();
        })
        .get("/", (ctx) => {
          ctx.response.body = RequestScope.get("requestId") ?? "missing";
          RequestScope.delete("requestId");
        }),
    );

    expect(await (await app(new Request("http://localhost/"))).text()).toBe("fresh");
    expect(await (await app(new Request("http://localhost/"))).text()).toBe("fresh");
  });

  test("is visible to middleware downstream of requestScope, before and after next()", async () => {
    const seen: boolean[] = [];

    const app = serve(
      new RhythmRouter()
        .use(requestScope())
        .use(async (_ctx, next) => {
          seen.push(RequestScope.isActive());
          await next();
          seen.push(RequestScope.isActive());
        })
        .get("/", (ctx) => {
          ctx.response.body = "ok";
        }),
    );

    await app(new Request("http://localhost/"));

    expect(seen).toEqual([true, true]);
  });

  test("exposes context mutations made by earlier middleware", async () => {
    type UserContext = RhythmHttpContext & { user?: string };

    const app = serve(
      new RhythmRouter()
        .use(requestScope())
        .use(async (ctx: UserContext, next) => {
          ctx.user = "ada";
          await next();
        })
        .get("/me", (ctx) => {
          ctx.response.body = RequestScope.context<UserContext>().user ?? "anonymous";
        }),
    );

    const res = await app(new Request("http://localhost/me"));

    expect(await res.text()).toBe("ada");
  });

  test("bare accessors throw RequestScopeError outside a scope", () => {
    expect(() => RequestScope.context()).toThrow(RequestScopeError);
    expect(() => RequestScope.get("requestId")).toThrow(RequestScopeError);
    expect(() => RequestScope.set("requestId", "x")).toThrow(RequestScopeError);
    expect(() => RequestScope.has("requestId")).toThrow(RequestScopeError);
    expect(() => RequestScope.delete("requestId")).toThrow(RequestScopeError);
    expect(() => RequestScope.context()).toThrow("outside an active request scope");
  });

  test("non-throwing accessors report absence outside a scope", () => {
    expect(RequestScope.isActive()).toBe(false);
    expect(RequestScope.contextOrNull()).toBeNull();
  });

  test("does not leak the scope once the request finishes", async () => {
    const app = serve(
      new RhythmRouter().use(requestScope()).get("/", (ctx) => {
        ctx.response.body = "ok";
      }),
    );

    await app(new Request("http://localhost/"));

    expect(RequestScope.isActive()).toBe(false);
  });

  test("run() opens a scope manually", async () => {
    const ctx = createHttpContext(new Request("http://localhost/manual"));

    const result = await RequestScope.run(ctx, async () => {
      RequestScope.set("requestId", "manual-1");
      await sleep(5);
      return `${new URL(RequestScope.context().request.url).pathname}:${RequestScope.get("requestId")}`;
    });

    expect(result).toBe("/manual:manual-1");
    expect(RequestScope.isActive()).toBe(false);
  });
});
