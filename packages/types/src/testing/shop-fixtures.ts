/**
 * Canonical `codespar_shop` wire fixtures.
 *
 * One per action/status, typed against the contract interfaces so they
 * cannot drift from the published types. A conformance test in any
 * registrant repo can import these and assert that its implementation
 * returns the same shapes (subset-shape: a registrant MAY add optional
 * fields beyond these, but MUST carry every field present here).
 *
 * The same fixtures are mirrored as JSON for the Python round-trip test
 * (packages/python/tests/_fixtures/shop_canonical.json) — keep the two
 * in sync by hand; any drift is a wire-contract break.
 */

import type {
  ShopSearchResult,
  ShopCheckoutResult,
  ShopStatusResult,
} from "../types.js";

/** `search` → flattened offers. Zero results would be `products: []`. */
export const SHOP_SEARCH_FIXTURE: ShopSearchResult = {
  rail: "vtex",
  products: [
    {
      product_id: "prod_1",
      sku_id: "sku_1",
      title: "Ração para gato 1kg",
      price_minor: 4990,
      currency: "BRL",
      image: "https://example.test/img/sku_1.jpg",
      url: "https://cobasi.test/p/sku_1",
      available: true,
      variants: [
        {
          sku_id: "sku_1",
          title: "1kg",
          price_minor: 4990,
          currency: "BRL",
          available: true,
        },
      ],
    },
  ],
};

/** `search` matching nothing — a success result, not an error. */
export const SHOP_SEARCH_EMPTY_FIXTURE: ShopSearchResult = {
  rail: "vtex",
  products: [],
};

/** `checkout` → async start. `status` is always the literal in_progress. */
export const SHOP_CHECKOUT_FIXTURE: ShopCheckoutResult = {
  checkout_session_id: "cks_abc123",
  status: "in_progress",
  message: "checkout started",
};

/** `checkout_status` still running. */
export const SHOP_STATUS_IN_PROGRESS_FIXTURE: ShopStatusResult = {
  checkout_session_id: "cks_abc123",
  status: "in_progress",
};

/** `checkout_status` terminal success — carries the payable Pix. */
export const SHOP_STATUS_READY_FIXTURE: ShopStatusResult = {
  checkout_session_id: "cks_abc123",
  status: "ready_for_payment",
  rail: "vtex",
  total_minor: 4990,
  pix_copia_e_cola: "00020126580014br.gov.bcb.pix0136cks-fixture5204000053039865802BR6304ABCD",
  order_status: "pending",
};

/** `checkout_status` terminal failure — carries the error. */
export const SHOP_STATUS_CANCELED_FIXTURE: ShopStatusResult = {
  checkout_session_id: "cks_def456",
  status: "canceled",
  error: "browser_worker_checkout_failed",
};

/** Every canonical fixture, keyed by a stable name for cross-repo use. */
export const SHOP_FIXTURES = {
  search: SHOP_SEARCH_FIXTURE,
  search_empty: SHOP_SEARCH_EMPTY_FIXTURE,
  checkout: SHOP_CHECKOUT_FIXTURE,
  status_in_progress: SHOP_STATUS_IN_PROGRESS_FIXTURE,
  status_ready_for_payment: SHOP_STATUS_READY_FIXTURE,
  status_canceled: SHOP_STATUS_CANCELED_FIXTURE,
} as const;
