/**
 * A package that declares @codespar/sdk in BOTH `dependencies` and
 * `peerDependencies` must declare the SAME range in each.
 *
 * @codespar/mcp declares both, and 0.5.6 shipped with them disagreeing: the
 * dependency accepted ^0.14.0 and the peer stopped at ^0.13.0. A release
 * script that widened "the range" found one of the two and left the other
 * behind, which is what happens whenever a fact is written down twice.
 *
 * Measured impact of that release, so this test is not sold as more than it
 * is: `npm i @codespar/mcp@0.5.6` installs cleanly, and so does
 * `--strict-peer-deps` — npm lets the direct dependency satisfy the peer. The
 * defect is a package that describes itself incorrectly, and a reader (a
 * resolver that is not npm, a person deciding what to pin) gets the wrong
 * answer from it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");

/** Every workspace manifest, as [name, manifest]. */
function manifests() {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PACKAGES, e.name, "package.json"))
    .filter((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    })
    .map((p) => JSON.parse(readFileSync(p, "utf8")));
}

/** Packages naming `dep` in both fields, with what each field says. */
export function disagreements(all, dep) {
  const out = [];
  for (const pkg of all) {
    const direct = pkg.dependencies?.[dep];
    const peer = pkg.peerDependencies?.[dep];
    if (direct && peer && direct !== peer) {
      out.push({ name: pkg.name, dependencies: direct, peerDependencies: peer });
    }
  }
  return out;
}

test("no workspace declares two different @codespar/sdk ranges for itself", () => {
  const found = disagreements(manifests(), "@codespar/sdk");
  assert.deepEqual(
    found,
    [],
    found.length === 0
      ? ""
      : [
          "A package declares @codespar/sdk in dependencies AND peerDependencies with",
          "different ranges, so it contradicts itself about which SDK it works with:",
          "",
          ...found.map(
            (f) => `  ${f.name}\n    dependencies:     ${f.dependencies}\n    peerDependencies: ${f.peerDependencies}`,
          ),
          "",
          "Widen BOTH, to the same string. Do not delete one to make this pass without",
          "deciding which it should be: `dependencies` means the package installs its",
          "own copy, `peerDependencies` means it uses the host's. A package that means",
          "both says both, identically.",
        ].join("\n"),
  );
});

test("control: the check reports a disagreement it is given, and stays quiet on agreement", () => {
  const range = "^1.0.0 || ^2.0.0";
  const agreeing = [
    { name: "a", dependencies: { "@codespar/sdk": range }, peerDependencies: { "@codespar/sdk": range } },
    { name: "b", dependencies: { "@codespar/sdk": range } },
    { name: "c", peerDependencies: { "@codespar/sdk": range } },
    { name: "d" },
  ];
  assert.deepEqual(disagreements(agreeing, "@codespar/sdk"), []);

  const drifted = [
    ...agreeing,
    {
      name: "e",
      dependencies: { "@codespar/sdk": `${range} || ^3.0.0` },
      peerDependencies: { "@codespar/sdk": range },
    },
  ];
  const found = disagreements(drifted, "@codespar/sdk");
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "e");
});
