/**
 * `cs.wallet`: a consumer's own account, over the REST routes.
 *
 * `cs.wallet.pixKeys` is the typed client of `/v1/consumers/:consumerId/pix-keys`
 * (list, register, delete), the routes the dashboard's "Minhas chaves" panel
 * and the `codespar_wallet` pix_keys_* actions act through. The REST routes
 * answer the key value (you are the account's operator); the meta-tool
 * answers tails and ids because a model reads its result.
 *
 * Deleting needs `{ confirm: true }`: without it nothing is sent and
 * `PixKeyDeleteNotConfirmedError` carries the consequence sentence, so a
 * program that forwards a person's answer cannot delete by omission.
 */

import { CodesparApiError, networkErrorToApiError, throwFromResponse, TimeoutError } from "./errors.js";
import { fetchWithTimeout } from "./internal/fetch.js";
import type {
  CallOptions,
  PixKey,
  PixKeyDeleted,
  PixKeyDeleteOptions,
  PixKeyList,
  PixKeyRegistered,
  PixKeyRegisterInput,
} from "./types.js";

interface WalletDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  timeout: number;
}

/** What the person is told before a key is deleted. */
export const PIX_KEY_DELETE_CONSEQUENCE = "Depois de excluída, esta chave deixa de apontar para esta conta.";

/** `delete` was called without `{ confirm: true }`: nothing was sent. */
export class PixKeyDeleteNotConfirmedError extends Error {
  readonly code = "pix_key_delete_requires_confirmation" as const;
  readonly consequence = PIX_KEY_DELETE_CONSEQUENCE;
  constructor(readonly key: string) {
    super(
      `pixKeys.delete needs { confirm: true } after the person confirmed. ${PIX_KEY_DELETE_CONSEQUENCE} Nothing was sent.`,
    );
    Object.setPrototypeOf(this, PixKeyDeleteNotConfirmedError.prototype);
    this.name = "PixKeyDeleteNotConfirmedError";
  }
}

export interface WalletPixKeys {
  /** `GET /v1/consumers/:consumerId/pix-keys`: the account's keys, read from the bank. A list that did not answer is an error, never empty. */
  list(consumerId: string, opts?: CallOptions): Promise<PixKeyList>;
  /**
   * `POST /v1/consumers/:consumerId/pix-keys`. `keyType` is explicit, EVP
   * included (a random key is never minted by omission); `key` for every
   * type but EVP. A Test project's own account registers only EVP.
   */
  register(consumerId: string, input: PixKeyRegisterInput, opts?: CallOptions): Promise<PixKeyRegistered>;
  /** `DELETE /v1/consumers/:consumerId/pix-keys/:key`, only with `{ confirm: true }`. */
  delete(consumerId: string, key: string, opts: PixKeyDeleteOptions): Promise<PixKeyDeleted>;
}

export interface Wallet {
  pixKeys: WalletPixKeys;
}

export function createWallet(deps: WalletDeps): Wallet {
  const auth: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
  if (deps.projectId) auth["x-codespar-project"] = deps.projectId;

  async function call<T>(what: string, url: string, init: Omit<RequestInit, "signal">, opts: CallOptions | undefined): Promise<T> {
    try {
      return await fetchWithTimeout(url, init, { timeout: opts?.timeout ?? deps.timeout, signal: opts?.signal }, async (r) => {
        if (!r.ok) await throwFromResponse(r, what);
        return (await r.json()) as T;
      });
    } catch (cause) {
      if (cause instanceof TimeoutError) throw cause;
      if (cause instanceof CodesparApiError) throw cause;
      if (opts?.signal?.aborted) throw cause;
      throw networkErrorToApiError(cause, what);
    }
  }

  const keysUrl = (consumerId: string) => `${deps.baseUrl}/v1/consumers/${encodeURIComponent(consumerId)}/pix-keys`;

  return {
    pixKeys: {
      async list(consumerId, opts) {
        return call<PixKeyList>("wallet.pixKeys.list", keysUrl(consumerId), { method: "GET", headers: { ...auth, Accept: "application/json" } }, opts);
      },
      async register(consumerId, input, opts) {
        const body: Record<string, unknown> = { key_type: input.keyType };
        if (input.keyType !== "EVP" && input.key !== undefined) body.key = input.key;
        return call<PixKeyRegistered>(
          "wallet.pixKeys.register",
          keysUrl(consumerId),
          { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
          opts,
        );
      },
      async delete(consumerId, key, opts) {
        if (opts?.confirm !== true) throw new PixKeyDeleteNotConfirmedError(key);
        return call<PixKeyDeleted>(
          "wallet.pixKeys.delete",
          `${keysUrl(consumerId)}/${encodeURIComponent(key)}`,
          { method: "DELETE", headers: { ...auth, Accept: "application/json" } },
          opts,
        );
      },
    },
  };
}
