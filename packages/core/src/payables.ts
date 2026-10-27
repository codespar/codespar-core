/**
 * `cs.payables`: pay documents and batches. Upload files (boleto PDFs,
 * Pix QR images, CSV/XLSX lists), build a batch, complement what the
 * files did not say, and pay the exact list you reviewed.
 *
 * Paying binds to the list's `version` and `list_hash`: any change after
 * you read the batch makes `pay` refuse with 409
 * `payable_batch_version_mismatch`, and the error body carries the
 * current batch in `error.details.batch` (`payableBatchFromError`). Repeating `pay` with the same
 * version and hash resumes; it never pays an item twice.
 */

import { CodesparApiError, networkErrorToApiError, throwFromResponse, TimeoutError } from "./errors.js";
import { fetchWithTimeout } from "./internal/fetch.js";
import { fileName, toBlob, type UploadInput } from "./internal/multipart.js";
import type {
  CallOptions,
  PayableBatch,
  PayableBatchCreated,
  PayableBatchCreateInput,
  PayableBatchPayInput,
  PayableFile,
  PayableIdempotentOptions,
  PayableItemInput,
  PayableItemUpdate,
  PayableItemsAddInput,
  PayableUploadOptions,
} from "./types.js";

export type { UploadInput } from "./internal/multipart.js";

interface PayablesDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  timeout: number;
}

export interface PayablesFiles {
  /** `POST /v1/payables/files`: one file, read in the request. 10 MB, 10 PDF pages, 500 CSV/XLSX rows. */
  upload(file: UploadInput, opts?: PayableUploadOptions): Promise<PayableFile>;
}

export interface PayablesBatches {
  /** `POST /v1/payables/batches`. Pass your own `idempotencyKey` to make a retry return the same batch. */
  create(input: PayableBatchCreateInput, opts?: PayableIdempotentOptions): Promise<PayableBatchCreated>;
  /** `GET /v1/payables/batches/:batchId`. */
  get(batchId: string, opts?: CallOptions): Promise<PayableBatch>;
  /** `PATCH /v1/payables/batches/:batchId/items/:itemId`: complement, correct, exclude or include one item, or choose its way (`rail`). */
  updateItem(
    batchId: string,
    itemId: string,
    update: PayableItemUpdate,
    opts?: CallOptions,
  ): Promise<PayableBatch>;
  /** `POST /v1/payables/batches/:batchId/items`: more files or stated items into an open batch. */
  addItems(batchId: string, input: PayableItemsAddInput, opts?: CallOptions): Promise<PayableBatch>;
  /**
   * `POST /v1/payables/batches/:batchId/pay`: confirm the exact list and
   * pay it. Each item carries its own `payment` result; a refused line
   * does not stop the others. The default idempotency key is derived from
   * the batch, version and hash, so a retry of the same confirmation is
   * the same request. While the API answers `executing` with items still
   * `ready` (its ~20 s budget per call), the same call is repeated, up to 30
   * times; the batch returned is the last answer.
   */
  pay(batchId: string, input: PayableBatchPayInput, opts?: PayableIdempotentOptions): Promise<PayableBatch>;
}

export interface Payables {
  files: PayablesFiles;
  batches: PayablesBatches;
}

/**
 * The current batch a 409 (`payable_batch_version_conflict` or
 * `payable_batch_version_mismatch`) carries in `error.details.batch`, so
 * the caller can show the new list and ask for a new confirmation.
 * `undefined` for any other error.
 */
export function payableBatchFromError(err: unknown): PayableBatch | undefined {
  if (!(err instanceof CodesparApiError) || err.status !== 409) return undefined;
  const body = err.body as { error?: { details?: { batch?: unknown } } } | undefined;
  const batch = body?.error?.details?.batch;
  return batch && typeof batch === "object" ? (batch as PayableBatch) : undefined;
}

function itemToWire(item: PayableItemInput): Record<string, unknown> {
  return dropUndefined({
    pix_key: item.pixKey,
    boleto_line: item.boletoLine,
    br_code: item.brCode,
    amount_minor: item.amountMinor,
    description: item.description,
    reference: item.reference,
  });
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** How many pay calls one `pay()` makes at most while the batch continues (about 20 s each). */
const PAY_MAX_ROUNDS = 30;

/** A pay call stopped at its time budget with items never sent: the same call continues them. */
function continuesOnRepeat(batch: PayableBatch): boolean {
  return batch.status === "executing" && batch.items.some((i) => i.state === "ready");
}

export function createPayables(deps: PayablesDeps): Payables {
  const base = `${deps.baseUrl}/v1/payables`;
  const auth: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
  if (deps.projectId) auth["x-codespar-project"] = deps.projectId;

  async function call<T>(
    what: string,
    url: string,
    init: Omit<RequestInit, "signal">,
    opts: CallOptions | undefined,
  ): Promise<T> {
    try {
      return await fetchWithTimeout(
        url,
        init,
        { timeout: opts?.timeout ?? deps.timeout, signal: opts?.signal },
        async (r) => {
          if (!r.ok) await throwFromResponse(r, what);
          return (await r.json()) as T;
        },
      );
    } catch (cause) {
      if (cause instanceof TimeoutError) throw cause;
      if (cause instanceof CodesparApiError) throw cause;
      if (opts?.signal?.aborted) throw cause;
      throw networkErrorToApiError(cause, what);
    }
  }

  function json(method: string, body: unknown, extra: Record<string, string> = {}) {
    return {
      method,
      headers: { ...auth, "Content-Type": "application/json", Accept: "application/json", ...extra },
      body: JSON.stringify(body),
    };
  }

  const batchUrl = (batchId: string) => `${base}/batches/${encodeURIComponent(batchId)}`;

  return {
    files: {
      async upload(file, opts) {
        const blob = await toBlob(file, opts?.contentType);
        const form = new FormData();
        form.append("file", blob, opts?.filename ?? fileName(file) ?? "document");
        // No Content-Type: fetch writes it with the boundary.
        return call<PayableFile>(
          "payables.files.upload",
          `${base}/files`,
          { method: "POST", headers: { ...auth, Accept: "application/json" }, body: form },
          opts,
        );
      },
    },
    batches: {
      async create(input, opts) {
        const body = dropUndefined({
          file_ids: input.fileIds,
          items: input.items?.map(itemToWire),
          source: input.source,
          conversation_id: input.conversationId,
        });
        const key = opts?.idempotencyKey ?? globalThis.crypto.randomUUID();
        return call<PayableBatchCreated>(
          "payables.batches.create",
          `${base}/batches`,
          json("POST", body, { "Idempotency-Key": key }),
          opts,
        );
      },
      async get(batchId, opts) {
        return call<PayableBatch>(
          "payables.batches.get",
          batchUrl(batchId),
          { method: "GET", headers: { ...auth, Accept: "application/json" } },
          opts,
        );
      },
      async updateItem(batchId, itemId, update, opts) {
        const body = dropUndefined({
          expected_version: update.expectedVersion,
          amount_minor: update.amountMinor,
          pix_key: update.pixKey,
          boleto_line: update.boletoLine,
          br_code: update.brCode,
          description: update.description,
          excluded: update.excluded,
          rail: update.rail,
        });
        return call<PayableBatch>(
          "payables.batches.updateItem",
          `${batchUrl(batchId)}/items/${encodeURIComponent(itemId)}`,
          json("PATCH", body),
          opts,
        );
      },
      async addItems(batchId, input, opts) {
        const body = dropUndefined({
          expected_version: input.expectedVersion,
          file_ids: input.fileIds,
          items: input.items?.map(itemToWire),
        });
        return call<PayableBatch>(
          "payables.batches.addItems",
          `${batchUrl(batchId)}/items`,
          json("POST", body),
          opts,
        );
      },
      async pay(batchId, input, opts) {
        const body = dropUndefined({
          version: input.version,
          list_hash: input.listHash,
          mandate_id: input.mandateId,
        });
        const key = opts?.idempotencyKey ?? `pay:${batchId}:${input.version}:${input.listHash}`;
        const once = () =>
          call<PayableBatch>("payables.batches.pay", `${batchUrl(batchId)}/pay`, json("POST", body, { "Idempotency-Key": key }), opts);
        // The API executes for about 20 s, then answers `executing` with the
        // items it did not reach still `ready`; nothing runs after the answer.
        // The same call continues them: paid items come back as they are, an
        // uncertain one is looked up, never resent.
        let batch = await once();
        for (let round = 1; round < PAY_MAX_ROUNDS && continuesOnRepeat(batch); round++) batch = await once();
        return batch;
      },
    },
  };
}
