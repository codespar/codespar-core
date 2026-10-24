// Self-test for the audit gate.
//
// Run: node --test scripts/audit-gate.test.mjs
//
// It opens with the accusations: a gate that has never blocked anything is
// indistinguishable from a broken one. Each shape that must stay red (critical,
// unlisted high, expired, fixable in range, unreadable audit) is planted first;
// then the one shape that may pass: a listed, unexpired high with no fix in range.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { advisoryId, validateExceptions, verdictFor } from "./audit-gate.mjs";

const ZOD = "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5";
const exception = { id: "GHSA-mrhx-c7xc-m3w5", package: "zod", severity: "high", expires: "2026-11-07", issue: "#214", justification: "x" };
const audit = (vulns) => ({ auditReportVersion: 2, vulnerabilities: vulns });
const zodHigh = (fixAvailable = { name: "zod", version: "4.6.7", isSemVerMajor: true }) => ({
  zod: { name: "zod", severity: "high", via: [{ source: 1, title: "Zod can exhaust memory", url: ZOD, severity: "high", range: "<4.6.6" }], fixAvailable },
});
const TODAY = "2026-10-24";

describe("blocks", () => {
  it("a critical, even if listed", () => {
    const a = audit({ zod: { ...zodHigh().zod, severity: "critical", via: [{ ...zodHigh().zod.via[0], severity: "critical" }] } });
    const v = verdictFor(a, [exception], TODAY);
    assert.equal(v.ok, false);
    assert.equal(v.blocked[0].reason, "critical");
  });
  it("a high that is not listed (another advisory, or the same one on another package)", () => {
    const other = audit({ "body-parser": { severity: "high", via: [{ title: "DoS", url: "https://github.com/advisories/GHSA-27r3-jxmh-p828", severity: "high" }], fixAvailable: false } });
    assert.equal(verdictFor(other, [exception], TODAY).blocked[0].reason, "not-listed");
    const samePkgOther = audit({ zod: { ...zodHigh().zod, via: [{ ...zodHigh().zod.via[0], url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] } });
    assert.equal(verdictFor(samePkgOther, [exception], TODAY).blocked[0].reason, "not-listed");
    const otherPkg = audit({ notzod: { ...zodHigh().zod, name: "notzod" } });
    assert.equal(verdictFor(otherPkg, [exception], TODAY).blocked[0].reason, "not-listed");
  });
  it("a listed high on or after its expiry date", () => {
    assert.equal(verdictFor(audit(zodHigh()), [exception], "2026-11-07").blocked[0].reason, "expired");
    assert.equal(verdictFor(audit(zodHigh()), [{ ...exception, expires: undefined }], TODAY).blocked[0].reason, "expired");
  });
  it("a listed high that npm can fix inside the declared range", () => {
    assert.equal(verdictFor(audit(zodHigh(true)), [exception], TODAY).blocked[0].reason, "fix-in-range");
    assert.equal(verdictFor(audit(zodHigh({ name: "zod", version: "3.25.99", isSemVerMajor: false })), [exception], TODAY).blocked[0].reason, "fix-in-range");
  });
  it("an audit it cannot read", () => {
    assert.equal(verdictFor(null, [exception], TODAY).ok, false);
    assert.equal(verdictFor({ error: { code: "ENOTFOUND", summary: "registry down" } }, [exception], TODAY).blocked[0].reason, "unreadable");
    assert.equal(verdictFor({}, [exception], TODAY).ok, false);
  });
});

describe("passes", () => {
  it("a listed, unexpired high whose only fix is a major (the zod case)", () => {
    const v = verdictFor(audit(zodHigh()), [exception], TODAY);
    assert.equal(v.ok, true);
    assert.deepEqual(v.accepted.map((a) => a.id), ["GHSA-mrhx-c7xc-m3w5"]);
    assert.equal(verdictFor(audit(zodHigh(false)), [exception], TODAY).ok, true);
  });
  it("moderates and string vias never block; an unused exception is reported", () => {
    const a = audit({
      hono: { severity: "moderate", via: [{ title: "m", url: "https://github.com/advisories/GHSA-1111-2222-3333", severity: "moderate" }], fixAvailable: true },
      "@codespar/sdk": { severity: "high", via: ["zod"], fixAvailable: false },
    });
    const v = verdictFor(a, [exception], TODAY);
    assert.equal(v.ok, true);
    assert.equal(v.reported.length, 1);
    assert.deepEqual(v.unused, ["zod GHSA-mrhx-c7xc-m3w5"]);
  });
});

describe("the exceptions file", () => {
  it("accepts only high, with id, package, expiry, issue and justification", () => {
    assert.deepEqual(validateExceptions([exception]), []);
    assert.ok(validateExceptions([{ ...exception, severity: "critical" }]).some((p) => p.includes("only high")));
    assert.ok(validateExceptions([{ ...exception, justification: "" }]).some((p) => p.includes("justification")));
    assert.ok(validateExceptions([{ ...exception, expires: "07/11/2026" }]).some((p) => p.includes("YYYY-MM-DD")));
    assert.ok(validateExceptions([{ ...exception, id: "CVE-2026-1" }]).some((p) => p.includes("GHSA")));
  });
  it("the committed file is valid", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = JSON.parse(fs.readFileSync(path.join(here, "audit-exceptions.json"), "utf8"));
    assert.deepEqual(validateExceptions(file.exceptions), []);
    for (const e of file.exceptions) assert.equal(advisoryId(e.id), e.id);
  });
});
