#!/usr/bin/env node
// audit-gate.mjs — the CI security audit, with a reviewed list of exceptions.
//
// Replaces `npm audit --omit=dev --audit-level=high`. That gate had no way to
// accept an advisory whose only fix is a semver-major migration (core#214:
// zod 3, GHSA-mrhx-c7xc-m3w5, no patched 3.x), so every PR went red at once,
// independent of its change.
//
// Blocks, in the production tree:
//   - every CRITICAL advisory;
//   - every HIGH advisory not listed in scripts/audit-exceptions.json;
//   - a listed HIGH whose exception has expired;
//   - a listed HIGH that npm can now fix inside the declared range
//     (`fixAvailable: true`, or a non-major fix): the fix is the answer;
//   - an audit it cannot read (registry down, malformed output): "could not
//     check" must not read as "clean".
// Moderates and lows are printed and never block, as before.
//
// Run: node scripts/audit-gate.mjs   (self-test: node --test scripts/audit-gate.test.mjs)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKING = new Set(["high", "critical"]);

/** "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx" → "GHSA-xxxx-xxxx-xxxx". */
export function advisoryId(url) {
  const m = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(String(url ?? ""));
  return m ? m[0] : null;
}

/** A fix npm can apply without leaving the declared range. */
function fixInRange(fixAvailable) {
  if (fixAvailable === true) return true;
  if (fixAvailable && typeof fixAvailable === "object") return fixAvailable.isSemVerMajor !== true;
  return false;
}

/**
 * The verdict for one `npm audit --json` body against the exceptions list.
 * `today` is a "YYYY-MM-DD" UTC date. Pure, so the self-test needs no network.
 */
export function verdictFor(audit, exceptions, today) {
  if (!audit || typeof audit !== "object" || audit.error || typeof audit.vulnerabilities !== "object" || audit.vulnerabilities === null) {
    return { ok: false, blocked: [{ reason: "unreadable", detail: audit?.error?.summary ?? "npm audit returned no vulnerabilities map" }], accepted: [], reported: [], unused: [] };
  }
  const blocked = [];
  const accepted = [];
  const reported = [];
  const used = new Set();
  for (const [pkg, v] of Object.entries(audit.vulnerabilities)) {
    for (const via of v.via ?? []) {
      // A string `via` is the package that carries the advisory; that package has its own entry.
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via.url);
      const severity = String(via.severity ?? v.severity ?? "").toLowerCase();
      const row = { package: pkg, id: id ?? String(via.source ?? via.url ?? "unknown"), severity, title: via.title ?? "", range: via.range ?? "" };
      if (!BLOCKING.has(severity)) {
        reported.push(row);
        continue;
      }
      if (severity === "critical") {
        blocked.push({ ...row, reason: "critical" });
        continue;
      }
      const ex = exceptions.find((e) => e.id === id && e.package === pkg);
      if (!ex) {
        blocked.push({ ...row, reason: "not-listed" });
        continue;
      }
      used.add(`${ex.package} ${ex.id}`);
      if (!(typeof ex.expires === "string" && today < ex.expires)) {
        blocked.push({ ...row, reason: "expired", expires: ex.expires });
        continue;
      }
      if (fixInRange(v.fixAvailable)) {
        blocked.push({ ...row, reason: "fix-in-range" });
        continue;
      }
      accepted.push({ ...row, expires: ex.expires, issue: ex.issue });
    }
  }
  const unused = exceptions.filter((e) => !used.has(`${e.package} ${e.id}`)).map((e) => `${e.package} ${e.id}`);
  return { ok: blocked.length === 0, blocked, accepted, reported, unused };
}

/** Exceptions file shape: only HIGH, with every field a reviewer needs. */
export function validateExceptions(list) {
  const problems = [];
  for (const [i, e] of list.entries()) {
    for (const k of ["id", "package", "severity", "expires", "issue", "justification"]) {
      if (typeof e[k] !== "string" || e[k].trim() === "") problems.push(`exception ${i}: missing ${k}`);
    }
    if (e.severity !== "high") problems.push(`exception ${i}: only high can be accepted (got ${e.severity})`);
    if (typeof e.expires === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) problems.push(`exception ${i}: expires must be YYYY-MM-DD`);
    if (typeof e.id === "string" && advisoryId(e.id) !== e.id) problems.push(`exception ${i}: id must be a GHSA id`);
  }
  return problems;
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = JSON.parse(fs.readFileSync(path.join(here, "audit-exceptions.json"), "utf8"));
  const exceptions = file.exceptions ?? [];
  const problems = validateExceptions(exceptions);
  if (problems.length > 0) {
    for (const p of problems) console.error(`audit-gate: ${p}`);
    process.exit(2);
  }
  let raw;
  try {
    raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // npm audit exits non-zero whenever it finds anything; its JSON is still on stdout.
    raw = err.stdout ?? "";
  }
  let audit;
  try {
    audit = JSON.parse(raw);
  } catch {
    audit = null;
  }
  const today = new Date().toISOString().slice(0, 10);
  const v = verdictFor(audit, exceptions, today);
  for (const r of v.reported) console.log(`reported (${r.severity}): ${r.package} ${r.id} ${r.title}`);
  for (const a of v.accepted) console.log(`accepted until ${a.expires}: ${a.package} ${a.id} ${a.title} (${a.issue})`);
  for (const u of v.unused) console.log(`exception no longer needed, remove it: ${u}`);
  for (const b of v.blocked) console.error(`BLOCKED (${b.reason}): ${b.package ?? ""} ${b.id ?? ""} ${b.severity ?? ""} ${b.title ?? b.detail ?? ""}${b.expires ? ` expired ${b.expires}` : ""}`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
