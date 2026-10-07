import { AsyncLocalStorage } from "node:async_hooks";
import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/context";

export interface RequestScopeStore {}

export class RequestScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestScopeError";
  }
}

interface ScopeFrame {
  readonly context: RhythmHttpContext;
  readonly store: Map<string | symbol, unknown>;
}

const frames = new AsyncLocalStorage<ScopeFrame>();

function activeFrame(operation: string): ScopeFrame {
  const frame = frames.getStore();
  if (frame === undefined) {
    throw new RequestScopeError(
      `RequestScope.${operation}() was called outside an active request scope. ` +
        "Register the requestScope() middleware before anything that uses RequestScope, " +
        "or open a scope manually with RequestScope.run().",
    );
  }
  return frame;
}

export function requestScope<TContext extends RhythmHttpContext = RhythmHttpContext>(): Middleware<TContext> {
  return async (ctx, next) => {
    await frames.run({ context: ctx, store: new Map() }, next);
  };
}

export class RequestScope {
  private constructor() {}

  static isActive(): boolean {
    return frames.getStore() !== undefined;
  }

  static context<TContext extends RhythmHttpContext = RhythmHttpContext>(): TContext {
    return activeFrame("context").context as TContext;
  }

  static contextOrNull<TContext extends RhythmHttpContext = RhythmHttpContext>(): TContext | null {
    return (frames.getStore()?.context as TContext | undefined) ?? null;
  }

  static get<K extends keyof RequestScopeStore>(key: K): RequestScopeStore[K] | undefined;
  static get<T = unknown>(key: string | symbol): T | undefined;
  static get(key: string | symbol): unknown {
    return activeFrame("get").store.get(key);
  }

  static set<K extends keyof RequestScopeStore>(key: K, value: RequestScopeStore[K]): void;
  static set<T = unknown>(key: string | symbol, value: T): void;
  static set(key: string | symbol, value: unknown): void {
    activeFrame("set").store.set(key, value);
  }

  static has(key: string | symbol): boolean {
    return activeFrame("has").store.has(key);
  }

  static delete(key: string | symbol): boolean {
    return activeFrame("delete").store.delete(key);
  }

  static run<TContext extends RhythmHttpContext, TResult>(context: TContext, fn: () => TResult): TResult {
    return frames.run({ context, store: new Map() }, fn);
  }
}
