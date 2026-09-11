/**
 * The CLI reports the version it actually is (oss-sdk#11).
 *
 * `src/version.ts` is a hand-kept literal, and its own header says so ("keep in
 * sync with package.json on release"). Nothing enforced that, so it fell behind
 * and the two artifacts a user reads — `codespar --version` and the User-Agent
 * every request carries — named a release that was not the one running.
 *
 * The existing header test asserts the User-Agent MATCHES a semver shape, which
 * is true of any version, including the wrong one. What is asserted here is the
 * value: the published `package.json` version is the only source, read at test
 * time, so this cannot pass while the constant drifts again.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api.js";
import { VERSION } from "../version.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = join(HERE, "../../package.json");

const published = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };

afterEach(() => vi.restoreAllMocks());

describe("the CLI version", () => {
  it("control: the published version was actually read", () => {
    // Without this, a package.json that failed to parse into a version would
    // make every comparison below compare undefined with undefined.
    expect(published.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is the version package.json publishes", () => {
    expect(VERSION).toBe(published.version);
  });

  it("is the version the User-Agent carries on a real request", async () => {
    let captured: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((_input: unknown, init: unknown) => {
      captured = (init as { headers: Record<string, string> }).headers;
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    await new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.x.dev" }).get("/v1/whoami");
    expect(captured["User-Agent"]).toBe(`codespar-cli/${published.version}`);
  });
});
