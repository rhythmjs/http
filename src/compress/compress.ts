import type { Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext, RhythmResponseBody } from "@rhythmjs/router/adapters/context";

export type CompressEncoding = "gzip" | "deflate" | "zstd";

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

async function toBytes(body: string | ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof body === "string") return new TextEncoder().encode(body) as Uint8Array<ArrayBuffer>;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Uint8Array) return body as Uint8Array<ArrayBuffer>;
  return (await body.bytes()) as Uint8Array<ArrayBuffer>;
}

function toStream(
  body: string | ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  return new Response(body).body!;
}

const compressSync: Partial<Record<CompressEncoding, (data: Uint8Array<ArrayBuffer>) => Uint8Array>> = {
  gzip: (data) => Bun.gzipSync(data),
  zstd: (data) => Bun.zstdCompressSync(data),
};

export function compress(options: CompressOptions = {}): Middleware<RhythmHttpContext> {
  const threshold = options.threshold ?? 1024;
  const encodings = options.encodings ?? ["zstd", "gzip", "deflate"];
  const isCompressible = options.filter ?? ((contentType: string) => COMPRESSIBLE_TYPE.test(contentType));

  return async (ctx, next) => {
    await next();

    const { response } = ctx;
    const streaming = response.body instanceof ReadableStream;
    const accept = ctx.request.headers.get("accept-encoding");
    const encoding = encodings.find((name) => (!streaming || name !== "zstd") && acceptsEncoding(accept, name));
    if (encoding === undefined) return;

    if (SKIP_STATUS.has(response.status)) return;
    if (response.body === null || response.body instanceof FormData || response.body instanceof URLSearchParams) return;
    if (response.headers.has("content-encoding")) return;
    if (!isCompressible(response.headers.get("content-type") ?? "")) return;

    const vary = response.headers.get("vary") ?? "";
    if (!/(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(vary)) response.headers.append("vary", "accept-encoding");

    const size = byteLength(response.body);
    if (size !== undefined && size < threshold) return;

    const body = response.body;
    const sync = compressSync[encoding];
    if (body instanceof ReadableStream || sync === undefined) {
      const compression = new CompressionStream(encoding as "gzip" | "deflate") as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >;
      response.body = toStream(body).pipeThrough(compression);
    } else {
      response.body = sync(await toBytes(body));
    }
    response.headers.set("content-encoding", encoding);
    response.headers.delete("content-length");
  };
}
