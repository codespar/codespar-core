#!/usr/bin/env node
// audit-gate.mjs — `npm audit --omit=dev` as a gate, with dated waivers.
//
// `npm audit --audit-level=high` has no way to set one advisory aside, so
// the first high finding with no patch in reach (an upstream pin, a major
// bump the consumers cannot take yet) turns the gate red for every PR of the
// repository, and the next person either lowers the level for everything or
// stops reading it. Measured on 2026-10-24 (core#216): zod < 4.6.6
// (GHSA-mrhx-c7xc-m3w5) is patched only in 4.6.6, and zod 3 is what
// @codespar/api-types and @modelcontextprotocol/sdk's zod-to-json-schema
// pin; the lock file of the PR was identical to main's, and main had been
// green eleven days earlier. The advisory's range was extended on
// 2026-10-23.
//
// The rule this enforces:
//
//   every advisory of severity >= `level` (default high) that reaches a
//   production dependency fails the gate, unless `audit-waivers.json` names
//   its GHSA id with a reason, the date it was waived and an expiry; a
//   waiver past its expiry fails the gate; a waiver for an advisory the
//   audit no longer reports fails the gate (it is deleted, not kept).
//
// Waivers are per advisory id, never per package or per severity, and
// every one has a date it stops working. The file is not a place to
// silence new findings: adding one is a reviewed change with the reason in
// the diff.
//
// Exit codes: 0 clean (or every finding waived), 1 a finding or a waiver
// violation, 2 the audit could not be read ("could not check" must not read
// as "clean").
//
//   node scripts/audit-gate.mjs            run `npm audit --omit=dev --json` and judge it
//   node scripts/audit-gate.mjs --self-test  prove the judge goes red when it should

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WAIVERS_PATH = join(HERE, "audit-waivers.json");
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** The advisories the audit report carries, one per GHSA id, with the packages they reach. */
export function findings(report) {
  const out = new Map();
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !via.url) continue;
      const id = via.url.split("/").pop();
      const entry = out.get(id) ?? { id, severity: via.severity, title: via.title, packages: new Set() };
      entry.packages.add(pkg);
      out.set(id, entry);
    }
  }
  return [...out.values()].map((f) => ({ ...f, packages: [...f.packages].sort() }));
}

/**
 * Judge a report against the waivers. Pure: takes the report, the waivers
 * and today's date, returns the violations. Empty means the gate is green.
 */
export function judge(report, waivers, today, level = "high") {
  const violations = [];
  const seen = new Set();
  const byId = new Map(waivers.map((w) => [w.id, w]));
  for (const w of waivers) {
    if (!w.id || !w.reason || !w.since || !w.expires) {
      violations.push({ kind: "waiver-incomplete", id: w.id ?? "?", detail: "a waiver needs id, reason, since and expires" });
    }
  }
  for (const f of findings(report)) {
    if ((RANK[f.severity] ?? 0) < RANK[level]) continue;
    const w = byId.get(f.id);
    if (!w) {
      violations.push({ kind: "finding", id: f.id, detail: `${f.severity}: ${f.title} (${f.packages.join(", ")})` });
      continue;
    }
    seen.add(f.id);
    if (w.expires <= today) {
      violations.push({ kind: "waiver-expired", id: f.id, detail: `waived on ${w.since}, expired ${w.expires}; the finding is still reported` });
    }
  }
  for (const w of waivers) {
    if (w.id && !seen.has(w.id) && !findings(report).some((f) => f.id === w.id)) {
      violations.push({ kind: "waiver-stale", id: w.id, detail: "the audit no longer reports this advisory; delete the waiver" });
    }
  }
  return violations;
}

function readAudit() {
  // `npm audit --json` exits 1 when it finds anything, so the exit code
  // carries no information here; the body does. An unparsable body is the
  // "could not check" case.
  let body;
  try {
    body = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    body = err.stdout;
  }
  try {
    const report = JSON.parse(body ?? "");
    if (!report || typeof report !== "object" || !("vulnerabilities" in report)) throw new Error("no vulnerabilities field");
    return report;
  } catch (err) {
    console.error(`audit-gate: could not read npm audit (${err.message}).`);
    process.exit(2);
  }
}

function selfTest() {
  const report = {
    vulnerabilities: {
      zod: { via: [{ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", title: "test high" }] },
      "fast-uri": { via: [{ url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "moderate", title: "test moderate" }] },
    },
  };
  const ok = (name, cond) => {
    if (!cond) {
      console.error(`audit-gate self-test: ${name} FAILED`);
      process.exit(1);
    }
  };
  ok("an unwaived high is a violation", judge(report, [], "2026-10-24").some((v) => v.kind === "finding" && v.id === "GHSA-aaaa-bbbb-cccc"));
  ok("a moderate below the level is not", !judge(report, [], "2026-10-24").some((v) => v.id === "GHSA-dddd-eeee-ffff"));
  const waiver = { id: "GHSA-aaaa-bbbb-cccc", reason: "r", since: "2026-10-24", expires: "2026-12-01" };
  ok("a current waiver clears it", judge(report, [waiver], "2026-10-24").length === 0);
  ok("an expired waiver is a violation", judge(report, [waiver], "2026-12-01").some((v) => v.kind === "waiver-expired"));
  ok("a stale waiver is a violation", judge({ vulnerabilities: {} }, [waiver], "2026-10-24").some((v) => v.kind === "waiver-stale"));
  ok("an incomplete waiver is a violation", judge(report, [{ id: "GHSA-aaaa-bbbb-cccc", reason: "r" }], "2026-10-24").some((v) => v.kind === "waiver-incomplete"));
  console.log("audit-gate self-test: 6 of 6 controls go red when they should.");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const waivers = JSON.parse(readFileSync(WAIVERS_PATH, "utf8")).waivers ?? [];
  const report = readAudit();
  const today = new Date().toISOString().slice(0, 10);
  const all = findings(report);
  for (const f of all) {
    const w = waivers.find((x) => x.id === f.id);
    console.log(`${f.severity.padEnd(9)} ${f.id}  ${f.title}  [${f.packages.join(", ")}]${w ? `  waived until ${w.expires}` : ""}`);
  }
  const violations = judge(report, waivers, today);
  if (violations.length === 0) {
    console.log(`audit-gate: ${all.length} advisories reported, none at or above high without a current waiver.`);
    return;
  }
  for (const v of violations) console.error(`audit-gate: ${v.kind} ${v.id}: ${v.detail}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
