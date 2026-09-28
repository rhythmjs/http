import type { Middleware } from "@rhythmjs/rhythm";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

export type SessionData = Record<string, unknown>;

export interface SessionStore {
  get(id: string): Promise<SessionData | undefined> | SessionData | undefined;
  set(id: string, data: SessionData, maxAge: number): Promise<void> | void;
  delete(id: string): Promise<void> | void;
}

export class MemoryStore implements SessionStore {
  #entries = new Map<string, { data: SessionData; expires: number }>();

  get(id: string): SessionData | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.#entries.delete(id);
      return undefined;
    }
    return entry.data;
  }

  set(id: string, data: SessionData, maxAge: number): void {
    this.#entries.set(id, { data, expires: Date.now() + maxAge * 1000 });
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }
}

export interface Session {
  readonly id: string;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  destroy(): void;
}

export type SessionContext = {
  session: Session;
};

export interface SessionOptions {
  store?: SessionStore;
  cookieName?: string;
  maxAge?: number;
  path?: string;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
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

export function session(options: SessionOptions = {}): Middleware<RhythmHttpContext> {
  const store = options.store ?? new MemoryStore();
  const cookieName = options.cookieName ?? "sid";
  const maxAge = options.maxAge ?? 86400;
  const path = options.path ?? "/";
  const sameSite = options.sameSite ?? "lax";
  const sameSiteLabel = `${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`;
  const secureAttribute = options.secure ? "; Secure" : "";
  const baseAttributes = `; Path=${path}; HttpOnly; SameSite=${sameSiteLabel}${secureAttribute}`;

  return async (ctx, next) => {
    const incomingId = readCookie(ctx.request.headers.get("cookie"), cookieName);
    const existing = incomingId === undefined ? undefined : await store.get(incomingId);
    const id = existing === undefined ? crypto.randomUUID() : (incomingId as string);
    const data: SessionData = { ...existing };
    let dirty = false;
    let destroyed = false;

    const current: Session = {
      id,
      get: <T = unknown>(key: string) => data[key] as T | undefined,
      set: (key, value) => {
        data[key] = value;
        dirty = true;
      },
      delete: (key) => {
        delete data[key];
        dirty = true;
      },
      destroy: () => {
        destroyed = true;
      },
    };

    await next({ session: current } satisfies SessionContext);

    if (destroyed) {
      if (incomingId !== undefined) await store.delete(incomingId);
      ctx.response.headers.append("set-cookie", `${cookieName}=; Max-Age=0${baseAttributes}`);
      return;
    }
    if (dirty) {
      await store.set(id, data, maxAge);
      if (existing === undefined) {
        ctx.response.headers.append("set-cookie", `${cookieName}=${id}; Max-Age=${maxAge}${baseAttributes}`);
      }
    }
  };
}
