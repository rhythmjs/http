import { describe, expect, test } from "vite-plus/test";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { proxy, type ProxyOptions } from "./proxy";

const serve = (router: RhythmRouter) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

interface Upstream {
  fetch: (request: Request) => Promise<Response>;
  requests: Request[];
}

const upstream = (respond: (request: Request) => Response | Promise<Response> = () => new Response("ok")): Upstream => {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (request) => {
      requests.push(request);
      return respond(request);
    },
  };
};

const app = (options: ProxyOptions) => serve(new RhythmRouter().use(proxy(options)));

describe("proxy forwarding", () => {
  test("forwards method, path, query, and body to the joined target url", async () => {
    const up = upstream(async (req) => new Response(`upstream saw: ${await req.text()}`));
    const handler = app({ target: "http://up.test/api", fetch: up.fetch });

    const res = await handler(
      new Request("http://localhost/v1/items?limit=5", {
        method: "POST",
        body: "payload",
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(await res.text()).toBe("upstream saw: payload");
    const sent = up.requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("http://up.test/api/v1/items?limit=5");
    expect(sent.headers.get("content-type")).toBe("text/plain");
  });

  test("applies the path rewrite", async () => {
    const up = upstream();
    const handler = app({
      target: "http://up.test",
      rewrite: (path) => path.replace(/^\/gateway/, ""),
      fetch: up.fetch,
    });

    await handler(new Request("http://localhost/gateway/users"));

    expect(new URL(up.requests[0]!.url).pathname).toBe("/users");
  });

  test("uses manual redirect handling by default and passes 3xx through", async () => {
    const up = upstream(() => new Response(null, { status: 302, headers: { location: "http://up.test/next?x=1" } }));
    const handler = app({ target: "http://up.test", fetch: up.fetch });

    const res = await handler(new Request("http://localhost/old"));

    expect(up.requests[0]!.redirect).toBe("manual");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/next?x=1");
  });
});

describe("request header hygiene", () => {
  const send = async (options: Partial<ProxyOptions>, headers: Record<string, string>) => {
    const up = upstream();
    const handler = app({ target: "http://up.test", fetch: up.fetch, ...options });
    await handler(new Request("http://localhost/", { headers }));
    return up.requests[0]!.headers;
  };

  test("strips hop-by-hop and soft-drop headers but forwards ordinary ones", async () => {
    const headers = await send(
      {},
      {
        accept: "application/json",
        "x-custom": "1",
        "accept-encoding": "br",
        te: "trailers",
        "proxy-authorization": "Basic secret",
      },
    );

    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-custom")).toBe("1");
    expect(headers.get("accept-encoding")).toBeNull();
    expect(headers.get("te")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
  });

  test("drops connection-nominated headers, and forwardHeaders cannot restore framing headers", async () => {
    const headers = await send(
      { forwardHeaders: ["connection", "x-internal"] },
      {
        connection: "x-internal",
        "x-internal": "1",
      },
    );

    expect(headers.get("connection")).toBeNull();
    expect(headers.get("x-internal")).toBeNull();
  });

  test("forwardHeaders can restore soft drops and filterHeaders strips credentials", async () => {
    const headers = await send(
      { forwardHeaders: ["host"], filterHeaders: ["cookie", "authorization"] },
      {
        host: "client.example",
        cookie: "sid=1",
        authorization: "Bearer t",
      },
    );

    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  test("explicit headers win over everything", async () => {
    const headers = await send({ headers: { "x-api-key": "k", accept: "text/csv" } }, { accept: "application/json" });

    expect(headers.get("x-api-key")).toBe("k");
    expect(headers.get("accept")).toBe("text/csv");
  });
});

describe("x-forwarded headers", () => {
  test("appends the client ip to the chain and overwrites proto/host/port", async () => {
    const up = upstream();
    const handler = app({ target: "http://up.test", fetch: up.fetch });
    const request = new Request("http://localhost:8080/", {
      headers: { "x-forwarded-for": "1.1.1.1", "x-forwarded-host": "spoofed.example", "x-forwarded-proto": "https" },
    });
    Object.defineProperty(request, "ip", { value: "9.9.9.9" });

    await handler(request);
    const headers = up.requests[0]!.headers;

    expect(headers.get("x-forwarded-for")).toBe("1.1.1.1, 9.9.9.9");
    expect(headers.get("x-forwarded-host")).toBe("localhost:8080");
    expect(headers.get("x-forwarded-proto")).toBe("http");
    expect(headers.get("x-forwarded-port")).toBe("8080");
  });

  test("xfwd false leaves the inbound chain untouched and adds nothing", async () => {
    const up = upstream();
    const handler = app({ target: "http://up.test", fetch: up.fetch, xfwd: false });

    await handler(new Request("http://localhost/", { headers: { "x-forwarded-for": "1.1.1.1" } }));
    const headers = up.requests[0]!.headers;

    expect(headers.get("x-forwarded-for")).toBe("1.1.1.1");
    expect(headers.get("x-forwarded-host")).toBeNull();
  });
});

describe("response relay", () => {
  test("relays status and headers, dropping stale encoding and hop-by-hop fields", async () => {
    const up = upstream(
      () =>
        new Response("body", {
          status: 201,
          headers: {
            "x-upstream": "yes",
            "content-encoding": "gzip",
            "content-length": "9999",
            connection: "keep-alive, x-secret",
            "x-secret": "internal",
          },
        }),
    );
    const handler = app({ target: "http://up.test", fetch: up.fetch });

    const res = await handler(new Request("http://localhost/"));

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("body");
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-secret")).toBeNull();
  });

  test("rewrites cookie domains and paths, preserving multiple cookies", async () => {
    const up = upstream(() => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Domain=up.test; Path=/api; HttpOnly");
      headers.append("set-cookie", "b=2; Domain=other.test");
      return new Response("ok", { headers });
    });
    const handler = app({
      target: "http://up.test",
      fetch: up.fetch,
      cookieDomainRewrite: { "up.test": "localhost", "other.test": "" },
      cookiePathRewrite: "/",
    });

    const res = await handler(new Request("http://localhost/"));

    expect(res.headers.getSetCookie()).toEqual(["a=1; Domain=localhost; Path=/; HttpOnly", "b=2"]);
  });

  test("locationRewrite maps prefixes and leaves third-party urls alone", async () => {
    const up = upstream(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://up.test/two/deep", refresh: "0; url=http://elsewhere.test/x" },
        }),
    );
    const handler = app({
      target: "http://up.test",
      fetch: up.fetch,
      locationRewrite: { "http://up.test/two/": "/one/" },
    });

    const res = await handler(new Request("http://localhost/"));

    expect(res.headers.get("location")).toBe("/one/deep");
    expect(res.headers.get("refresh")).toBe("0; url=http://elsewhere.test/x");
  });
});

describe("failure modes", () => {
  test("responds 502 when the upstream is unreachable", async () => {
    const handler = app({ target: "http://up.test", fetch: () => Promise.reject(new Error("ECONNREFUSED")) });

    const res = await handler(new Request("http://localhost/"));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, status: 502, message: "Bad Gateway" });
  });

  test("responds 504 when the upstream exceeds the timeout", async () => {
    const hang = (request: Request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const handler = app({ target: "http://up.test", fetch: hang, timeout: 20 });

    const res = await handler(new Request("http://localhost/"));

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ success: false, status: 504, message: "Gateway Timeout" });
  });
});
