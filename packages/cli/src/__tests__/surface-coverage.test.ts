/**
 * The coverage gate for the CLI's command surface.
 *
 * It compares two published lists against what this CLI actually
 * registers:
 *
 *   API_OPERATIONS (@codespar/sdk)                → resource groups
 *   SHARED_META_TOOL_DEFINITIONS (@codespar/types) → the 15 meta-tools
 *
 * A resource group must have a derived command group, or an entry in
 * SURFACE_EXCEPTIONS carrying a reason and a date. The exception list is
 * a ratchet pinned by EXCEPTION_PIN: it may shrink, never grow.
 *
 * The checker (`auditSurface`) is a pure function of the surface passed
 * to it, so this file also runs it on synthetic surfaces — one covered,
 * one not — and a checker that cannot go red fails its own controls.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXCEPTION_PIN,
  OPERATIONS,
  PUBLISHED_GROUPS,
  SURFACE_EXCEPTIONS,
  auditSurface,
  census,
  censusGroup,
  claimingGroup,
  derivedSurface,
  metaToolNames,
} from "../surface.js";
import { requireDefinition } from "../commands/meta-tool.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Census groups a derived command group covers. */
function coveredGroups(): string[] {
  const covered = new Set<string>();
  for (const { spec, commands } of derivedSurface()) {
    expect(commands.length, `${spec.name} derived no command`).toBeGreaterThan(0);
    for (const command of commands) covered.add(censusGroup(command.path));
  }
  return [...covered];
}

function liveAudit() {
  return auditSurface({
    censusGroups: [...census().keys()],
    coveredGroups: coveredGroups(),
    exceptions: SURFACE_EXCEPTIONS,
    publishedMetaTools: metaToolNames(),
    invocableMetaTools: metaToolNames().filter((name) => {
      try {
        return requireDefinition(name).name === name;
      } catch {
        return false;
      }
    }),
  });
}

describe("CLI surface coverage", () => {
  it("gives every resource group of the served document a command or a written exception", () => {
    const violations = liveAudit();
    expect(
      violations.map((v) => `${v.kind}: ${v.detail}`),
      [
        "A resource group of the served OpenAPI document has no CLI and no exception.",
        "",
        "DO NOT close this by adding an entry to SURFACE_EXCEPTIONS — that is the lazy",
        "fix and it makes the CLI narrower while the number stays green. Publishing the",
        "group is ONE ROW in PUBLISHED_GROUPS (name + path prefix + description); the",
        "subcommands are then derived from the operation table with no further code.",
        "",
        "Signature of the real cause: the group appeared because packages/core refreshed",
        "openapi-snapshot.json and the API grew a route family. That is a group to",
        "publish, not to except.",
        "",
        "An exception is only for a family with no terminal use (a browser redirect, a",
        "machine-to-machine handshake, a probe). It needs a reason that says which, and",
        "the date it was written. Evidence accepted for a NEW exception: the route list",
        "of the family, and one sentence on who calls it instead of a person.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("holds the exception ratchet at its pin", () => {
    const count = Object.keys(SURFACE_EXCEPTIONS).length;
    expect(
      count,
      [
        `SURFACE_EXCEPTIONS has ${count} entries and EXCEPTION_PIN says ${EXCEPTION_PIN}.`,
        "",
        `If ${count} > ${EXCEPTION_PIN}: an exception was ADDED. Don't raise the pin. Publish`,
        "the group instead (one row in PUBLISHED_GROUPS). Raising the pin needs the",
        "founder's sign-off in the PR body, naming the family and why it has no terminal use.",
        "",
        `If ${count} < ${EXCEPTION_PIN}: an exception was RETIRED, which is the point of the`,
        `ratchet. Lower EXCEPTION_PIN to ${count} in the same commit.`,
      ].join("\n"),
    ).toBe(EXCEPTION_PIN);
  });

  it("publishes every meta-tool the definitions publish, and no invented one", () => {
    const published = metaToolNames();
    expect(published).toHaveLength(15);
    for (const name of published) expect(requireDefinition(name).name).toBe(name);
    // The CLI must not know a name the definitions do not publish: an
    // invented tool would look invocable in --help and fail at the wire.
    expect(() => requireDefinition("codespar_not_published")).toThrow(/Unknown meta-tool/);
  });

  it("still finds no /v1/admin/* operation in the served document", () => {
    // The API matrix v2.1.1 names an admin/account family. It has no
    // served route, so there is no exception for it and no command. When
    // this goes red the routes shipped: publish the group.
    expect(OPERATIONS.filter((op) => op.path.startsWith("/v1/admin"))).toEqual([]);
  });

  it("claims every operation of a published group exactly once", () => {
    const claimed = new Map<string, number>();
    for (const { commands } of derivedSurface()) {
      for (const command of commands) {
        const key = `${command.method} ${command.path}`;
        claimed.set(key, (claimed.get(key) ?? 0) + 1);
      }
    }
    const expected = OPERATIONS.filter((op) => claimingGroup(op.path) !== undefined);
    expect(claimed.size).toBe(expected.length);
    expect([...claimed.values()].filter((n) => n !== 1)).toEqual([]);
  });
});

describe("auditSurface controls", () => {
  const exception = { reason: "x".repeat(30), since: "2026-09-10" };
  const base = {
    censusGroups: ["alpha", "beta"],
    coveredGroups: ["alpha"],
    exceptions: { beta: exception },
    publishedMetaTools: ["codespar_alpha"],
    invocableMetaTools: ["codespar_alpha"],
  };

  it("positive control: a covered group plus a written exception is clean", () => {
    expect(auditSurface(base)).toEqual([]);
  });

  it("negative control: an uncovered group with no exception is reported", () => {
    const violations = auditSurface({ ...base, exceptions: {} });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "uncovered-group", subject: "beta" });
  });

  it("negative control: an exception with no usable reason is reported", () => {
    const violations = auditSurface({
      ...base,
      exceptions: { beta: { reason: "later", since: "2026-09-10" } },
    });
    expect(violations.map((v) => v.kind)).toEqual(["empty-reason"]);
  });

  it("negative control: an exception with no ISO date is reported", () => {
    const violations = auditSurface({
      ...base,
      exceptions: { beta: { reason: "x".repeat(30), since: "someday" } },
    });
    expect(violations.map((v) => v.kind)).toEqual(["bad-date"]);
  });

  it("negative control: an exception for a group that is covered, or gone, is reported", () => {
    expect(
      auditSurface({ ...base, exceptions: { ...base.exceptions, alpha: exception } }).map(
        (v) => v.subject,
      ),
    ).toEqual(["alpha"]);
    expect(
      auditSurface({ ...base, exceptions: { ...base.exceptions, gamma: exception } }).map(
        (v) => v.kind,
      ),
    ).toEqual(["stale-exception"]);
  });

  it("negative control: a published meta-tool the CLI cannot invoke is reported", () => {
    const violations = auditSurface({ ...base, invocableMetaTools: [] });
    expect(violations.map((v) => v.kind)).toEqual(["meta-tool-missing"]);
  });
});

/* ── Hand-written path ratchet ───────────────────────────────────── */

/**
 * Paths the CLI builds by hand instead of dispatching through the
 * generated operation table. Each of these is a route the served OpenAPI
 * document does not declare, so nothing checks it: a rename on the
 * backend reaches the user as a 404 at runtime.
 *
 * This list is a ratchet too. It exists to stop the number growing while
 * the drift is worked off route by route; it is NOT a place to register
 * a new hand-written call.
 */
const OFF_SPEC_PATHS = [
  // `/v1/consents/init` and `/v1/consumers/mandates/{}/spend` left this list
  // when core#143 refreshed the snapshot to 221 operations: both are now
  // declared by the served document, so the generated table checks them. The
  // ratchet went DOWN, which is the only direction it is allowed to move
  // without an argument.
  "/v1/consents/{}/submit",
  "/v1/consumers/{}/wallet/transfer",
  "/v1/logs/stream",
  "/v1/servers/{}",
  "/v1/sessions/{}/close",
  "/v1/sessions/{}/logs",
  "/v1/tools",
  "/v1/tools/{}",
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Comments out. A path named in prose — a JSDoc line explaining which
 * route a command hits, or an exception's reason — is documentation, not
 * traffic, and counting it would make the scanner report a request that
 * does not exist. Block comments go first, then line comments, and a
 * `//` preceded by `:` is left alone so a `https://` inside a string
 * does not swallow the rest of the line.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every `/v1/...` literal in the CLI's own source, with `${...}` → `{}`. */
function handWrittenPaths(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    for (const match of source.matchAll(/["'`](\/v1\/[^"'`\s]*)["'`]/g)) {
      const raw = match[1]!;
      const normalised = raw.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}");
      // A path prefix declared in PUBLISHED_GROUPS is a routing rule, not
      // a request: the requests under it dispatch through the generated
      // table, so the prefix is not hand-written traffic.
      if (normalised.includes("$")) continue;
      if (PUBLISHED_GROUPS.some((g) => g.prefix === normalised)) continue;
      found.add(normalised);
    }
  }
  return [...found].sort();
}

describe("hand-written REST paths", () => {
  it("are exactly the ones already known to be off the served document", () => {
    const declared = new Set(
      OPERATIONS.map((op) => op.path.replace(/\{[^}]*\}/g, "{}")),
    );
    const offSpec = handWrittenPaths().filter((p) => !declared.has(p));
    expect(
      offSpec,
      [
        "A path written by hand in the CLI is not an operation of the served OpenAPI",
        "document, and it is not one of the ten already known.",
        "",
        "DO NOT close this by appending the path to OFF_SPEC_PATHS. That list is a debt",
        "register with a downward ratchet, not an allowlist. Dispatch through the",
        "generated table instead: add the group to PUBLISHED_GROUPS, or call",
        "`cs.api.request(method, path, ...)` with a path the document declares.",
        "",
        "Signature of the real cause: someone needed a route the SDK snapshot does not",
        "carry. Either the route is undocumented on the backend (fix the backend's",
        "OpenAPI, then `npm run spec:refresh` in packages/core), or the path is simply",
        "wrong and would 404 in production the first time it ran.",
        "",
        "Evidence accepted for retiring an entry: the operation appears in",
        "API_OPERATIONS and the command dispatches through it.",
      ].join("\n"),
    ).toEqual(OFF_SPEC_PATHS);
  });

  it("control: the scanner reads code and ignores prose", () => {
    const source = [
      '// a comment naming "/v1/ghost/line" must not count',
      "/* a block comment naming `/v1/ghost/block` must not count */",
      'const real = await client.get("/v1/real/path");',
      'const url = "https://api.codespar.dev/v1/absolute";',
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).not.toContain("/v1/ghost/line");
    expect(stripped).not.toContain("/v1/ghost/block");
    expect(stripped).toContain("/v1/real/path");
    expect(stripped).toContain("https://api.codespar.dev/v1/absolute");
  });

  it("positive control: the scanner does see the spec-declared paths the CLI calls", () => {
    // If the scanner silently found nothing, the ratchet above would pass
    // for the wrong reason. It must also see paths that ARE declared.
    const declared = new Set(
      OPERATIONS.map((op) => op.path.replace(/\{[^}]*\}/g, "{}")),
    );
    const onSpec = handWrittenPaths().filter((p) => declared.has(p));
    expect(onSpec).toContain("/v1/whoami");
    expect(onSpec.length).toBeGreaterThan(3);
  });
});

describe("published groups", () => {
  it("names each group once and derives at least one command for it", () => {
    const names = PUBLISHED_GROUPS.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    for (const { spec, commands } of derivedSurface()) {
      expect(commands.length, `${spec.name} derived no command`).toBeGreaterThan(0);
      expect(new Set(commands.map((c) => c.name)).size).toBe(commands.length);
    }
  });
});
