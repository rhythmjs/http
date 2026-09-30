import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext, RhythmResponseBody } from "@rhythmjs/router/adapters/context";

export type CompressEncoding = "gzip" | "deflate";

export interface CompressOptions {
  threshold?: number;
  encodings?: CompressEncoding[];
  filter?: (contentType: string) => boolean;
}

const COMPRESSIBLE_TYPE =
  /^(text\/(?!event-stream)|application\/(json|javascript|xml|rss\+xml|atom\+xml|xhtml\+xml|wasm$)|image\/svg\+xml|font\/(ttf|otf)$)/i;

const SKIP_STATUS = new Set([204, 304]);

function acceptsEncoding(header: string | null, encoding: string): boolean {
  if (header === null) return false;
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (name?.trim().toLowerCase() !== encoding) continue;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key?.trim().toLowerCase() === "q" && Number(value) === 0) return false;
    }
    return true;
  }
  return false;
}

function byteLength(body: RhythmResponseBody): number | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return undefined;
}

function toStream(
  body: string | ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  return new Response(body).body!;
}

export function compress(options: CompressOptions = {}): Middleware<RhythmHttpContext> {
  const threshold = options.threshold ?? 1024;
  const encodings = options.encodings ?? ["gzip", "deflate"];
  const isCompressible = options.filter ?? ((contentType: string) => COMPRESSIBLE_TYPE.test(contentType));

  return async (ctx, next) => {
    await next();

    const { response } = ctx;
    const accept = ctx.request.headers.get("accept-encoding");
    const encoding = encodings.find((name) => acceptsEncoding(accept, name));
    if (encoding === undefined) return;

    if (SKIP_STATUS.has(response.status)) return;
    if (response.body === null || response.body instanceof FormData || response.body instanceof URLSearchParams) return;
    if (response.headers.has("content-encoding")) return;
    if (!isCompressible(response.headers.get("content-type") ?? "")) return;

    const vary = response.headers.get("vary") ?? "";
    if (!/(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(vary)) response.headers.append("vary", "accept-encoding");

    const size = byteLength(response.body);
    if (size !== undefined && size < threshold) return;

    const compression = new CompressionStream(encoding) as ReadableWritablePair<Uint8Array, Uint8Array>;
    response.body = toStream(response.body).pipeThrough(compression);
    response.headers.set("content-encoding", encoding);
    response.headers.delete("content-length");
  };
}
