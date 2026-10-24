/**
 * multipart/form-data bodies for the generated client and the payables
 * facade. The part bytes are materialised as a Blob before the request
 * starts: FormData cannot carry a stream, and a file larger than the
 * API accepts is refused by the API, not by buffering here.
 */

/** Anything the SDK accepts as the bytes of an uploaded file. */
export type UploadInput =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>;

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== "undefined" && v instanceof Blob;
}

function isWebStream(v: unknown): v is ReadableStream<Uint8Array> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ReadableStream).getReader === "function"
  );
}

function isAsyncIterable(v: unknown): v is AsyncIterable<Uint8Array | string> {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

/** True for the values `toBlob` turns into file bytes. */
export function isUploadInput(v: unknown): v is UploadInput {
  return (
    isBlob(v) ||
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v) ||
    isWebStream(v) ||
    isAsyncIterable(v)
  );
}

/**
 * Read an upload input into a Blob. A Node `Readable` is an async
 * iterable of Buffers (or strings with an encoding set), a web
 * `ReadableStream` is read through `Response`.
 */
export async function toBlob(input: UploadInput, contentType?: string): Promise<Blob> {
  const type = contentType ?? "";
  if (isBlob(input)) {
    return contentType && input.type !== contentType ? new Blob([input], { type }) : input;
  }
  if (input instanceof ArrayBuffer) return new Blob([input], { type });
  if (ArrayBuffer.isView(input)) {
    // slice() copies into a plain ArrayBuffer: a view over a
    // SharedArrayBuffer is not a BlobPart.
    const view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
    return new Blob([view], { type });
  }
  if (isWebStream(input)) {
    const blob = await new Response(input).blob();
    return new Blob([blob], { type });
  }
  if (isAsyncIterable(input)) {
    const parts: BlobPart[] = [];
    for await (const chunk of input) {
      parts.push(typeof chunk === "string" ? chunk : new Uint8Array(chunk));
    }
    return new Blob(parts, { type });
  }
  throw new TypeError("upload input must be a Blob, File, Buffer, ArrayBuffer, typed array or stream");
}

/** The name a File carries, or the basename of an fs read stream's path. */
export function fileName(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { name, path } = v as { name?: unknown; path?: unknown };
  if (typeof name === "string" && name !== "") return name;
  if (typeof path === "string" && path !== "") return path.split(/[\\/]/).pop() || undefined;
  return undefined;
}

/**
 * Build the FormData of a multipart operation. A FormData is passed
 * through; an object becomes one part per key (arrays repeat the key),
 * file-like values become file parts named after the File or the key,
 * everything else a text field.
 */
export async function toFormData(body: unknown): Promise<FormData> {
  if (body instanceof FormData) return body;
  const form = new FormData();
  if (!body || typeof body !== "object") return form;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      if (isUploadInput(v)) {
        form.append(key, await toBlob(v), fileName(v) ?? key);
      } else {
        form.append(key, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
  }
  return form;
}
