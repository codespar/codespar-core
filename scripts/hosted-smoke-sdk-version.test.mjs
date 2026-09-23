/**
 * Self-test for the smoke's SDK version resolver: the pure choice across
 * both modes, and the registry read's three answers (published, 404,
 * unreachable) through a stubbed fetch.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { pickVersion } from "./hosted-smoke-sdk-version.mjs";
import { RegistryError, publishedVersions } from "./npm-registry.mjs";

const PUBLISHED = ["0.16.3", "0.16.4", "0.16.5", "0.17.0-rc.1"];

describe("pickVersion", () => {
  it("returns the workspace version when it is published, in either mode", () => {
    assert.deepEqual(pickVersion("exact", "0.16.5", PUBLISHED), { version: "0.16.5" });
    assert.deepEqual(pickVersion("at-or-below", "0.16.5", PUBLISHED), { version: "0.16.5" });
  });

  it("exact: an unpublished bump is an error naming the gap", () => {
    const r = pickVersion("exact", "0.16.6", PUBLISHED);
    assert.match(r.error, /0\.16\.6 is not on the registry/);
  });

  it("at-or-below: an unpublished bump falls back to the newest release below it, with a warning", () => {
    const r = pickVersion("at-or-below", "0.16.6", PUBLISHED);
    assert.equal(r.version, "0.16.5");
    assert.match(r.warning, /runs against 0\.16\.5/);
  });

  it("at-or-below: prereleases are never candidates", () => {
    const r = pickVersion("at-or-below", "0.18.0", PUBLISHED);
    assert.equal(r.version, "0.16.5");
  });

  it("at-or-below: nothing below the workspace version is an error", () => {
    const r = pickVersion("at-or-below", "0.16.2", PUBLISHED);
    assert.match(r.error, /no published .* release is at or below/);
  });

  it("an empty release list (404) is 'never published' in both modes", () => {
    assert.match(pickVersion("exact", "0.16.5", []).error, /never been published/);
    assert.match(pickVersion("at-or-below", "0.16.5", []).error, /never been published/);
  });

  it("rejects an unknown mode and a non-release workspace version", () => {
    assert.match(pickVersion("latest", "0.16.5", PUBLISHED).error, /SMOKE_SDK_MODE/);
    assert.match(pickVersion("exact", "0.16.5-rc.1", PUBLISHED).error, /non-release/);
  });
});

describe("publishedVersions", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("lists the versions of a published package document", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ versions: { "0.1.0": {}, "0.2.0": {} } }), { status: 200 });
    assert.deepEqual(await publishedVersions("@codespar/sdk"), ["0.1.0", "0.2.0"]);
  });

  it("a 404 is 'never published': an empty list, not an error", async () => {
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    assert.deepEqual(await publishedVersions("@codespar/sdk"), []);
  });

  it("any other non-OK status is a RegistryError", async () => {
    globalThis.fetch = async () => new Response("down", { status: 503 });
    await assert.rejects(publishedVersions("@codespar/sdk"), RegistryError);
  });

  it("a network failure is a RegistryError naming the cause", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    };
    await assert.rejects(publishedVersions("@codespar/sdk"), (err) => {
      assert.ok(err instanceof RegistryError);
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    });
  });
});
