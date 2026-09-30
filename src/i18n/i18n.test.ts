import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { Rhythm } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";
import { detectLanguage, i18n, type I18nOptions, parseAcceptLanguage } from "./i18n";

const serve = (router: RhythmRouter<any>) => toFetchHandler(new Rhythm<RhythmHttpContext>().use(router.middleware()));

const instance = () =>
  createInstance({
    supportedLngs: ["en", "de", "fr"],
    fallbackLng: "en",
    resources: {
      en: { translation: { greeting: "Hello", named: "Hello {{name}}" } },
      de: { translation: { greeting: "Hallo", named: "Hallo {{name}}" } },
      fr: { translation: { greeting: "Bonjour" } },
    },
  });

const app = (options?: Partial<I18nOptions>) =>
  serve(
    new RhythmRouter().use(i18n({ i18next: instance(), ...options })).get("/greet", (ctx) => {
      ctx.response.body = JSON.stringify({ language: ctx.language, greeting: ctx.t("greeting") });
    }),
  );

const greet = async (handler: (req: Request) => Promise<Response>, url: string, headers?: Record<string, string>) => {
  const res = await handler(new Request(url, { headers }));
  return { res, body: (await res.json()) as { language: string; greeting: string } };
};

describe("i18n middleware", () => {
  test("falls back to the instance fallback language", async () => {
    const { res, body } = await greet(app(), "http://localhost/greet");
    expect(body).toEqual({ language: "en", greeting: "Hello" });
    expect(res.headers.get("content-language")).toBe("en");
  });

  test("detects the language from the querystring", async () => {
    const { body } = await greet(app(), "http://localhost/greet?lng=de");
    expect(body).toEqual({ language: "de", greeting: "Hallo" });
  });

  test("detects the language from the cookie", async () => {
    const { body } = await greet(app(), "http://localhost/greet", { cookie: "i18next=fr" });
    expect(body).toEqual({ language: "fr", greeting: "Bonjour" });
  });

  test("detects the language from Accept-Language ordered by quality", async () => {
    const { body } = await greet(app(), "http://localhost/greet", { "accept-language": "fr;q=0.8,de;q=0.9" });
    expect(body.language).toBe("de");
  });

  test("matches region variants against base languages", async () => {
    const { body } = await greet(app(), "http://localhost/greet", { "accept-language": "de-AT,en;q=0.5" });
    expect(body).toEqual({ language: "de", greeting: "Hallo" });
  });

  test("querystring wins over cookie and header by default", async () => {
    const { body } = await greet(app(), "http://localhost/greet?lng=fr", {
      cookie: "i18next=de",
      "accept-language": "en",
    });
    expect(body.language).toBe("fr");
  });

  test("unsupported candidates fall through to the fallback", async () => {
    const { body } = await greet(app(), "http://localhost/greet?lng=xx", { "accept-language": "ja" });
    expect(body.language).toBe("en");
  });

  test("detects the language from a path segment when configured", async () => {
    const handler = serve(
      new RhythmRouter()
        .use(i18n({ i18next: instance(), detection: { order: ["path"] } }))
        .get("/:lng/greet", (ctx) => {
          ctx.response.body = ctx.t("greeting");
        }),
    );
    const res = await handler(new Request("http://localhost/de/greet"));
    expect(await res.text()).toBe("Hallo");
  });

  test("requests do not leak language state into each other", async () => {
    const handler = app();
    const [de, fr, fallback] = await Promise.all([
      greet(handler, "http://localhost/greet?lng=de"),
      greet(handler, "http://localhost/greet?lng=fr"),
      greet(handler, "http://localhost/greet"),
    ]);
    expect(de.body.greeting).toBe("Hallo");
    expect(fr.body.greeting).toBe("Bonjour");
    expect(fallback.body.greeting).toBe("Hello");
  });

  test("interpolation works through ctx.t", async () => {
    const handler = serve(
      new RhythmRouter().use(i18n({ i18next: instance() })).get("/named", (ctx) => {
        ctx.response.body = ctx.t("named", { name: "Ada" });
      }),
    );
    const res = await handler(new Request("http://localhost/named?lng=de"));
    expect(await res.text()).toBe("Hallo Ada");
  });

  test("cacheCookie persists the resolved language and skips redundant writes", async () => {
    const handler = app({ cacheCookie: true });
    const first = await handler(new Request("http://localhost/greet?lng=de"));
    expect(first.headers.get("set-cookie")).toBe("i18next=de; Max-Age=31536000; Path=/; SameSite=Lax");

    const second = await handler(new Request("http://localhost/greet", { headers: { cookie: "i18next=de" } }));
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(((await second.json()) as { language: string }).language).toBe("de");
  });

  test("contentLanguage: false leaves the header untouched", async () => {
    const { res } = await greet(app({ contentLanguage: false }), "http://localhost/greet");
    expect(res.headers.get("content-language")).toBeNull();
  });

  test("a pre-set Content-Language header is left alone", async () => {
    const handler = serve(
      new RhythmRouter().use(i18n({ i18next: instance() })).get("/greet", (ctx) => {
        ctx.response.headers.set("content-language", "x-custom");
        ctx.response.body = "ok";
      }),
    );
    const res = await handler(new Request("http://localhost/greet"));
    expect(res.headers.get("content-language")).toBe("x-custom");
  });

  test("initializes an uninitialized instance on first use", async () => {
    const uninitialized = createInstance({
      fallbackLng: "en",
      resources: { en: { translation: { greeting: "Hello" } } },
    });
    const { body } = await greet(app({ i18next: uninitialized }), "http://localhost/greet");
    expect(body.greeting).toBe("Hello");
  });
});

describe("parseAcceptLanguage", () => {
  test("orders by quality and drops q=0", () => {
    expect(parseAcceptLanguage("en;q=0.5, de, fr;q=0, es;q=0.9")).toEqual([
      { language: "de", quality: 1 },
      { language: "es", quality: 0.9 },
      { language: "en", quality: 0.5 },
    ]);
  });

  test("handles null, empty, and malformed headers", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(parseAcceptLanguage("de;q=broken")).toEqual([{ language: "de", quality: 1 }]);
  });
});

describe("detectLanguage", () => {
  test("respects a custom order and lookup names", () => {
    const request = new Request("http://localhost/?locale=de", { headers: { cookie: "lang=fr" } });
    expect(detectLanguage(request, { order: ["cookie"], lookupCookie: "lang" })).toBe("fr");
    expect(detectLanguage(request, { order: ["querystring"], lookupQuerystring: "locale" })).toBe("de");
  });

  test("matches against supportedLanguages and falls back", () => {
    const request = new Request("http://localhost/", { headers: { "accept-language": "pt-BR,ja;q=0.8" } });
    expect(detectLanguage(request, { supportedLanguages: ["pt", "en"] })).toBe("pt");
    expect(detectLanguage(request, { supportedLanguages: ["de"], fallbackLanguage: "de" })).toBe("de");
    expect(detectLanguage(request, { supportedLanguages: ["de"] })).toBeUndefined();
  });

  test("reads a path segment at the configured index", () => {
    const request = new Request("http://localhost/api/de/users");
    expect(detectLanguage(request, { order: ["path"], lookupPath: 1 })).toBe("de");
  });
});

describe("i18n instance compatibility", () => {
  test("works without cloneInstance via getFixedT", async () => {
    const minimal = {
      isInitialized: true,
      language: "en",
      options: { supportedLngs: ["en", "de"], fallbackLng: "en" },
      t: () => "base",
      getFixedT: (lng: string) => () => `fixed:${lng}`,
    };
    const handler = serve(
      new RhythmRouter().use(i18n({ i18next: minimal })).get("/greet", (ctx) => {
        ctx.response.body = `${ctx.language}:${ctx.t()}`;
      }),
    );
    const res = await handler(new Request("http://localhost/greet?lng=de"));
    expect(await res.text()).toBe("de:fixed:de");
  });

  test("works with only t and changeLanguage", async () => {
    let current = "en";
    const bare = {
      isInitialized: true,
      options: { fallbackLng: "en" },
      get language() {
        return current;
      },
      t: () => `t:${current}`,
      changeLanguage: (lng: string) => {
        current = lng;
      },
    };
    const handler = serve(
      new RhythmRouter().use(i18n({ i18next: bare })).get("/greet", (ctx) => {
        ctx.response.body = ctx.t();
      }),
    );
    const res = await handler(new Request("http://localhost/greet?lng=de"));
    expect(await res.text()).toBe("t:de");
    expect(res.headers.get("content-language")).toBe("de");
  });

  test("works with nothing but a t function", async () => {
    const handler = serve(
      new RhythmRouter().use(i18n({ i18next: { t: () => "static" } })).get("/greet", (ctx) => {
        ctx.response.body = `${ctx.t()}:${ctx.language || "none"}`;
      }),
    );
    const res = await handler(new Request("http://localhost/greet?lng=de"));
    expect(await res.text()).toBe("static:de");
  });
});
