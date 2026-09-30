import type { DeriveMiddleware, Middleware } from "@rhythmjs/rhythm/types";
import type { RhythmHttpContext } from "@rhythmjs/router/adapters/context";

/** The form-data shape `request.formData()` actually returns (undici's under `@types/node`). */
export type RequestFormData = Awaited<ReturnType<Request["formData"]>>;
/** The file entry type of that form data. */
export type FormFile = Exclude<ReturnType<RequestFormData["get"]>, string | null>;

export interface MultipartOptions {
  maxBytes?: number;
  maxFileSize?: number;
  maxFiles?: number;
  maxFields?: number;
}

export class MultipartForm {
  #data: RequestFormData;

  constructor(data: RequestFormData) {
    this.#data = data;
  }

  get data(): RequestFormData {
    return this.#data;
  }

  get(name: string): string | undefined {
    const value = this.#data.get(name);
    return typeof value === "string" ? value : undefined;
  }

  getAll(name: string): string[] {
    return this.#data.getAll(name).filter((value): value is string => typeof value === "string");
  }

  file(name: string): FormFile | undefined {
    for (const value of this.#data.getAll(name)) {
      if (typeof value !== "string") return value;
    }
    return undefined;
  }

  files(name?: string): FormFile[] {
    const values = name === undefined ? [...this.#data.values()] : this.#data.getAll(name);
    return values.filter((value): value is FormFile => typeof value !== "string");
  }
}

export type MultipartContext = {
  form: MultipartForm;
};

class PayloadTooLargeError extends Error {}

function isTooLarge(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth++) {
    if (current instanceof PayloadTooLargeError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function parse(request: Request, maxBytes: number | undefined): Promise<RequestFormData> {
  if (maxBytes === undefined || request.body === null) return request.formData();
  let total = 0;
  const reader = request.body.getReader();
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) controller.error(new PayloadTooLargeError());
      else controller.enqueue(value);
    },
  });
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const init = { method: request.method, headers, body: limited, duplex: "half" };
  return new Request(request.url, init as RequestInit).formData();
}

export function multipart(options: MultipartOptions = {}): DeriveMiddleware<RhythmHttpContext, MultipartContext> {
  const { maxBytes, maxFileSize, maxFiles, maxFields } = options;

  const middleware: Middleware<RhythmHttpContext & Partial<MultipartContext>> = async (ctx, next) => {
    const reject = (status: number, message: string): void => {
      ctx.response.status = status;
      ctx.response.headers.set("content-type", "application/json");
      ctx.response.body = JSON.stringify({ success: false, status, message });
    };

    const contentType = ctx.request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      reject(415, "Unsupported Media Type");
      return;
    }
    if (ctx.request.body === null) {
      reject(400, "Bad Request");
      return;
    }
    const contentLength = ctx.request.headers.get("content-length");
    if (maxBytes !== undefined && contentLength !== null && Number(contentLength) > maxBytes) {
      reject(413, "Payload Too Large");
      return;
    }

    let data: RequestFormData;
    try {
      data = await parse(ctx.request, maxBytes);
    } catch (error) {
      if (isTooLarge(error)) reject(413, "Payload Too Large");
      else reject(400, "Bad Request");
      return;
    }

    let fileCount = 0;
    let fieldCount = 0;
    for (const value of data.values()) {
      if (value instanceof File) {
        fileCount++;
        if (maxFileSize !== undefined && value.size > maxFileSize) {
          reject(413, "Payload Too Large");
          return;
        }
      } else {
        fieldCount++;
      }
    }
    if ((maxFiles !== undefined && fileCount > maxFiles) || (maxFields !== undefined && fieldCount > maxFields)) {
      reject(413, "Payload Too Large");
      return;
    }

    ctx.form = new MultipartForm(data);
    await next();
  };

  return middleware as DeriveMiddleware<RhythmHttpContext, MultipartContext>;
}
