import type { DeriveMiddleware, Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export type DetectionSource = "querystring" | "cookie" | "header" | "path";

export interface LanguageDetectionOptions {
  order?: DetectionSource[];
  lookupQuerystring?: string;
  lookupCookie?: string;
  lookupPath?: number;
  supportedLanguages?: string[];
  fallbackLanguage?: string;
}

// Structural contract instead of i18next's own types: every member is optional except `t`, and the
// middleware feature-detects each one at runtime, so i18next major versions that add, rename, or
// drop members (e.g. v26 removing `initImmediate`) cannot break compilation or runtime behavior.
export interface I18nInstanceLike {
  t: (...args: any[]) => any;
  isInitialized?: boolean;
  language?: string;
  resolvedLanguage?: string;
  options?: { supportedLngs?: unknown; fallbackLng?: unknown };
  init?: (...args: any[]) => any;
  cloneInstance?: (...args: any[]) => any;
  changeLanguage?: (...args: any[]) => any;
  getFixedT?: (...args: any[]) => (...args: any[]) => any;
}

export interface I18nContext<TInstance extends I18nInstanceLike = I18nInstanceLike> {
  i18n: TInstance;
  t: TInstance["t"];
  language: string;
}

export interface I18nOptions<TInstance extends I18nInstanceLike = I18nInstanceLike> {
  i18next: TInstance;
  detection?: LanguageDetectionOptions;
  cacheCookie?: boolean;
  cacheCookieMaxAge?: number;
  contentLanguage?: boolean;
}

export interface AcceptedLanguage {
  language: string;
  quality: number;
}

export function parseAcceptLanguage(header: string | null): AcceptedLanguage[] {
  if (!header) return [];
  const accepted: AcceptedLanguage[] = [];
  for (const part of header.split(",")) {
    const [tag, ...params] = part.trim().split(";");
    const language = tag?.trim();
    if (!language) continue;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key?.trim().toLowerCase() !== "q") continue;
      const parsed = Number.parseFloat(value ?? "");
      if (!Number.isNaN(parsed)) quality = Math.min(Math.max(parsed, 0), 1);
    }
    if (quality > 0) accepted.push({ language, quality });
  }
  return accepted.sort((a, b) => b.quality - a.quality);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function candidatesFrom(request: Request, options: LanguageDetectionOptions): string[] {
  const order = options.order ?? ["querystring", "cookie", "header"];
  const url = new URL(request.url);
  for (const source of order) {
    let candidates: string[] = [];
    if (source === "querystring") {
      const value = url.searchParams.get(options.lookupQuerystring ?? "lng");
      if (value) candidates = [value];
    } else if (source === "cookie") {
      const value = readCookie(request.headers.get("cookie"), options.lookupCookie ?? "i18next");
      if (value) candidates = [value];
    } else if (source === "path") {
      const segments = url.pathname.split("/").filter((segment) => segment !== "");
      const value = segments[options.lookupPath ?? 0];
      if (value) candidates = [value];
    } else {
      candidates = parseAcceptLanguage(request.headers.get("accept-language"))
        .map((entry) => entry.language)
        .filter((language) => language !== "*");
    }
    if (candidates.length > 0) return candidates;
  }
  return [];
}

function matchLanguage(candidates: string[], supported: string[] | undefined): string | undefined {
  if (supported === undefined || supported.length === 0) return candidates[0];
  const byLower = new Map(supported.map((language) => [language.toLowerCase(), language]));
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const exact = byLower.get(lower);
    if (exact !== undefined) return exact;
    const base = byLower.get(lower.split("-")[0] as string);
    if (base !== undefined) return base;
    const baseOfSupported = supported.find((language) => language.toLowerCase().split("-")[0] === lower);
    if (baseOfSupported !== undefined) return baseOfSupported;
  }
  return undefined;
}

export function detectLanguage(request: Request, options: LanguageDetectionOptions = {}): string | undefined {
  return matchLanguage(candidatesFrom(request, options), options.supportedLanguages) ?? options.fallbackLanguage;
}

function supportedFromInstance(instance: I18nInstanceLike): string[] | undefined {
  const supported = instance.options?.supportedLngs;
  if (!Array.isArray(supported)) return undefined;
  const languages = supported.filter(
    (language): language is string => typeof language === "string" && language !== "cimode",
  );
  return languages.length > 0 ? languages : undefined;
}

function fallbackFromInstance(instance: I18nInstanceLike): string | undefined {
  const fallback = instance.options?.fallbackLng;
  if (typeof fallback === "string") return fallback;
  if (Array.isArray(fallback) && typeof fallback[0] === "string") return fallback[0];
  return undefined;
}

function isInstanceLike(value: unknown): value is I18nInstanceLike {
  return typeof value === "object" && value !== null && typeof (value as I18nInstanceLike).t === "function";
}

async function scopeInstance<TInstance extends I18nInstanceLike>(
  instance: TInstance,
  language: string | undefined,
): Promise<{ scoped: TInstance; translate: TInstance["t"]; resolved: string }> {
  if (typeof instance.cloneInstance === "function") {
    const clone: unknown = instance.cloneInstance();
    if (isInstanceLike(clone)) {
      const scoped = clone as TInstance;
      if (language !== undefined && language !== scoped.language && typeof scoped.changeLanguage === "function") {
        await scoped.changeLanguage(language);
      }
      return {
        scoped,
        translate: scoped.t.bind(scoped) as TInstance["t"],
        resolved: scoped.resolvedLanguage ?? scoped.language ?? language ?? "",
      };
    }
  }
  if (language !== undefined && typeof instance.getFixedT === "function") {
    return { scoped: instance, translate: instance.getFixedT(language) as TInstance["t"], resolved: language };
  }
  if (language !== undefined && language !== instance.language && typeof instance.changeLanguage === "function") {
    await instance.changeLanguage(language);
  }
  return {
    scoped: instance,
    translate: instance.t.bind(instance) as TInstance["t"],
    resolved: instance.resolvedLanguage ?? instance.language ?? language ?? "",
  };
}

export function i18n<TInstance extends I18nInstanceLike>(
  options: I18nOptions<TInstance>,
): DeriveMiddleware<RhythmHttpContext, I18nContext<TInstance>> {
  const instance = options.i18next;
  const detection = options.detection ?? {};
  const cookieName = detection.lookupCookie ?? "i18next";
  const cacheCookieMaxAge = options.cacheCookieMaxAge ?? 31536000;
  let initializing: Promise<unknown> | undefined;

  const middleware: Middleware<RhythmHttpContext & Partial<I18nContext<TInstance>>> = async (ctx, next) => {
    if (instance.isInitialized !== true && typeof instance.init === "function") {
      initializing ??= Promise.resolve(instance.init());
      await initializing;
    }

    const supported = detection.supportedLanguages ?? supportedFromInstance(instance);
    const fallback = detection.fallbackLanguage ?? fallbackFromInstance(instance);
    const language = matchLanguage(candidatesFrom(ctx.request, detection), supported) ?? fallback;

    const { scoped, translate, resolved } = await scopeInstance(instance, language);

    ctx.i18n = scoped;
    ctx.t = translate;
    ctx.language = resolved;

    await next();

    if (
      options.cacheCookie === true &&
      resolved !== "" &&
      readCookie(ctx.request.headers.get("cookie"), cookieName) !== resolved
    ) {
      ctx.response.headers.append(
        "set-cookie",
        `${cookieName}=${encodeURIComponent(resolved)}; Max-Age=${cacheCookieMaxAge}; Path=/; SameSite=Lax`,
      );
    }
    if (options.contentLanguage !== false && resolved !== "" && ctx.response.headers.get("content-language") === null) {
      ctx.response.headers.set("content-language", resolved);
    }
  };
  return middleware as DeriveMiddleware<RhythmHttpContext, I18nContext<TInstance>>;
}
