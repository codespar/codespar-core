// Self-test for the publish-drift guard.
//
// Run: node --test scripts/
//
// The first test is the one that matters. A guard that has never accused
// anything is indistinguishable from a broken guard, so the suite opens by
// planting exactly the state that produced core#129 — content changed, version
// left alone, that version already on the registry — and requires a failure.
// The rest of the suite is the other side of the control: the shapes that must
// NOT fire, so the guard stays something people can leave switched on.
//
// Everything here is hermetic. `verdictFor` takes two directories and a waiver
// list, so the registry is represented by a directory, not a network call.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { compareTrees, treeFingerprint, hashTree, verdictFor } from "./check-publish-drift.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "drift-selftest-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
/** Materialise a package tree from { "relative/path": "contents" }. */
function tree(files) {
  const dir = path.join(scratch, `t${seq++}`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

// The published 0.10.15 shape: three meta-tool definitions.
const PUBLISHED = {
  "package.json": JSON.stringify({ name: "@codespar/types", version: "0.10.15" }),
  "dist/meta-tool-definitions.js":
    'export const D = { codespar_invoice: {}, codespar_notify: {}, codespar_pay: {} };\n',
};

// What main actually carries: the same version string, twelve more definitions.
const MAIN_UNBUMPED = {
  ...PUBLISHED,
  "dist/meta-tool-definitions.js":
    'export const D = { codespar_invoice: {}, codespar_notify: {}, codespar_pay: {}, codespar_wallet: {}, codespar_kyc: {}, codespar_discover: {} };\n',
};

describe("publish drift guard", () => {
  it("NON-VACUITY: fails when content moved and the version did not", () => {
    const verdict = verdictFor({
      name: "@codespar/types",
      version: "0.10.15",
      localDir: tree(MAIN_UNBUMPED),
      publishedDir: tree(PUBLISHED),
    });

    assert.equal(verdict.status, "drift");
    assert.match(verdict.reason, /immutable/);
    assert.deepEqual(
      verdict.diff.changed.map((c) => c.file),
      ["dist/meta-tool-definitions.js"],
    );
  });

  it("stays silent on a package nobody touched", () => {
    const verdict = verdictFor({
      name: "@codespar/vercel",
      version: "0.4.1",
      localDir: tree(PUBLISHED),
      publishedDir: tree(PUBLISHED),
    });

    assert.equal(verdict.status, "pass");
    assert.equal(verdict.diff.drifted, false);
  });

  it("passes a legitimate change that carries a bump", () => {
    // A bumped version is absent from the registry, which the caller
    // signals with publishedDir: null. The new content ships with it.
    const verdict = verdictFor({
      name: "@codespar/types",
      version: "0.10.16",
      localDir: tree(MAIN_UNBUMPED),
      publishedDir: null,
    });

    assert.equal(verdict.status, "pass");
    assert.match(verdict.reason, /not on the registry/);
  });

  it("reports which files moved, and by how much", () => {
    const diff = compareTrees(tree(MAIN_UNBUMPED), tree(PUBLISHED));
    const [changed] = diff.changed;

    assert.equal(changed.file, "dist/meta-tool-definitions.js");
    assert.ok(
      changed.localBytes > changed.publishedBytes,
      "the local build is the larger side here",
    );
  });

  it("sees a file that exists only on one side", () => {
    const withExtra = tree({ ...PUBLISHED, "dist/conformance.js": "export const C = 1;\n" });
    const diff = compareTrees(withExtra, tree(PUBLISHED));

    assert.deepEqual(
      diff.added.map((a) => a.file),
      ["dist/conformance.js"],
    );

    const inverse = compareTrees(tree(PUBLISHED), withExtra);
    assert.deepEqual(
      inverse.removed.map((r) => r.file),
      ["dist/conformance.js"],
    );
  });

  describe("waivers for drift that predates the guard", () => {
    const localDir = tree(MAIN_UNBUMPED);
    const publishedDir = tree(PUBLISHED);
    const fingerprint = compareTrees(localDir, publishedDir).fingerprint;
    const waiver = {
      name: "@codespar/types",
      version: "0.10.15",
      fingerprint,
      issue: "core#129",
    };

    it("lets through the exact state it was written for", () => {
      const verdict = verdictFor({
        name: "@codespar/types",
        version: "0.10.15",
        localDir,
        publishedDir,
        waivers: [waiver],
      });

      assert.equal(verdict.status, "waived");
      assert.match(verdict.reason, /core#129/);
    });

    it("does NOT cover the next drift in the same package", () => {
      // One more definition on top of the waived state. The waiver names a
      // fingerprint, not a package, so it stops applying the moment the
      // content moves again — which is what keeps it from becoming a mute
      // button on this package forever.
      const movedAgain = tree({
        ...MAIN_UNBUMPED,
        "dist/meta-tool-definitions.js":
          MAIN_UNBUMPED["dist/meta-tool-definitions.js"].replace("};", ", codespar_ledger: {} };"),
      });

      const verdict = verdictFor({
        name: "@codespar/types",
        version: "0.10.15",
        localDir: movedAgain,
        publishedDir,
        waivers: [waiver],
      });

      assert.equal(verdict.status, "drift");
      assert.match(verdict.reason, /does not cover this state/);
    });

    it("fails as stale once the package is bumped", () => {
      const verdict = verdictFor({
        name: "@codespar/types",
        version: "0.10.16",
        localDir,
        publishedDir: null,
        waivers: [waiver],
      });

      assert.equal(verdict.status, "stale-waiver");
      assert.match(verdict.reason, /stale/);
    });

    it("fails as stale once the drift is gone", () => {
      const verdict = verdictFor({
        name: "@codespar/types",
        version: "0.10.15",
        localDir: publishedDir,
        publishedDir,
        waivers: [waiver],
      });

      assert.equal(verdict.status, "stale-waiver");
      assert.match(verdict.reason, /stale waiver/);
    });

    it("does not tell a correctly bumped package that it forgot to bump", () => {
      // A stale waiver and real drift both stop the build, but they are not
      // the same finding and the fixes are opposites: one wants a version,
      // the other wants a deleted line. Reporting a bumped package under
      // "changed without a version bump" sends the reader to fix the one
      // thing that is already correct.
      const bumped = verdictFor({
        name: "@codespar/types",
        version: "0.10.16",
        localDir,
        publishedDir: null,
        waivers: [waiver],
      });
      const unbumped = verdictFor({
        name: "@codespar/types",
        version: "0.10.15",
        localDir,
        publishedDir,
      });

      assert.notEqual(bumped.status, unbumped.status);
      assert.equal(unbumped.status, "drift");
      assert.doesNotMatch(bumped.reason, /bump the version/);
      assert.match(bumped.reason, /delete it/);
    });
  });

  it("fingerprints a tree stably, and only by content", () => {
    const a = treeFingerprint(hashTree(tree(PUBLISHED)));
    const b = treeFingerprint(hashTree(tree(PUBLISHED)));
    const c = treeFingerprint(hashTree(tree(MAIN_UNBUMPED)));

    assert.equal(a, b, "same content in a different directory hashes the same");
    assert.notEqual(a, c);
  });
});
