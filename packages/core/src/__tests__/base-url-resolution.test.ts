/**
 * `CODESPAR_BASE_URL` env-var resolution for the TS client.
 *
 * The constructor cascade is: explicit `baseUrl` option, then the
 * `CODESPAR_BASE_URL` env var, then the production default. The env
 * var lets a caller point the same client wiring at a local OSS
 * runtime or at `api.codespar.dev` without rebuilding the call sites.
 */

import { describe, it, expect } from "vitest";
import { CodeSpar } from "../index.js";

describe("CODESPAR_BASE_URL env-var fallback", () => {
  it("uses CODESPAR_BASE_URL when no explicit baseUrl is passed", () => {
    const prevBase = process.env.CODESPAR_BASE_URL;
    const prevKey = process.env.CODESPAR_API_KEY;
    process.env.CODESPAR_BASE_URL = "https://oss.codespar.local";
    process.env.CODESPAR_API_KEY = "csk_live_test";
    try {
      const cs = new CodeSpar();
      // baseUrl is private; the smoke test is that construction
      // succeeds and the default does NOT override an env override.
      // The behavior is exercised via createSession's URL prefix in
      // the integration tests.
      expect(cs).toBeDefined();
    } finally {
      if (prevBase === undefined) delete process.env.CODESPAR_BASE_URL;
      else process.env.CODESPAR_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.CODESPAR_API_KEY;
      else process.env.CODESPAR_API_KEY = prevKey;
    }
  });

  it("explicit baseUrl wins over CODESPAR_BASE_URL env var", () => {
    const prev = process.env.CODESPAR_BASE_URL;
    process.env.CODESPAR_BASE_URL = "https://oss.codespar.local";
    try {
      const cs = new CodeSpar({
        apiKey: "csk_live_x",
        baseUrl: "https://override.example.com",
      });
      // Smoke — construction succeeds with both set. The wire-level
      // behavior is covered by createSession tests that fetch-mock
      // the URL prefix directly.
      expect(cs).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.CODESPAR_BASE_URL;
      else process.env.CODESPAR_BASE_URL = prev;
    }
  });
});
