#!/usr/bin/env node
// openapi-spec.mjs — the served OpenAPI document is the source of the
// typed REST client in src/api/. Nothing about the 213 operations is
// written by hand: the snapshot is fetched from the API, the types are
// generated from the snapshot, and the runtime operation table (method,
// path, body and accept content types) is generated alongside them.
//
// Three modes:
//
//   node scripts/openapi-spec.mjs generate   snapshot -> src/generated/*
//   node scripts/openapi-spec.mjs refresh    served   -> snapshot -> src/generated/*
//   node scripts/openapi-spec.mjs check      exit 1 when anything is stale
//
// `check` answers three questions, in order:
//   1. does the snapshot's recorded sha256 match its own document
//      (someone edited the snapshot by hand)?
//   2. do the generated files equal what the snapshot generates
//      (someone edited src/generated/ by hand, or forgot to regenerate)?
//   3. does the served document still equal the snapshot
//      (the API moved and the client no longer describes it)?
// Questions 1 and 2 need no network. Question 3 does; `--offline` skips
// it. A served document that cannot be fetched exits 2, never 0: "could
// not check" must not read as "current".
//
// The comparison in (3) is by content, not by ETag or byte equality: the
// server sends no ETag, and a proxy re-serialising the same document
// must not read as drift.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

export const SPEC_URL =
  process.env.CODESPAR_OPENAPI_URL ?? "https://api.codespar.dev/openapi.json";
export const SNAPSHOT_PATH = path.join(PKG_ROOT, "openapi-snapshot.json");
export const TYPES_PATH = path.join(PKG_ROOT, "src", "generated", "openapi.ts");
export const OPERATIONS_PATH = path.join(PKG_ROOT, "src", "generated", "operations.ts");

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

// ---------------------------------------------------------------------------
// Pure helpers — no network, no filesystem. The tests drive these directly.
// ---------------------------------------------------------------------------

/** sha256 of the compact JSON serialisation, so whitespace never counts as drift. */
export function documentSha256(document) {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

/** Every `METHOD /path` pair in an OpenAPI document, in document order. */
export function listOperations(document) {
  const out = [];
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item && typeof item === "object" && item[method]) {
        out.push({ method, path: route, operation: item[method] });
      }
    }
  }
  return out;
}

/** Content type of the request body, or null when the operation takes none. */
function requestContentType(operation) {
  const content = operation.requestBody?.content;
  if (!content) return null;
  const keys = Object.keys(content);
  if (keys.length !== 1) {
    throw new Error(
      `operation declares ${keys.length} request content types (${keys.join(", ")}); ` +
        "the generated client sends exactly one and needs a rule for this case",
    );
  }
  return keys[0];
}

/** Content type of the first documented 2xx response, or null when it has no body. */
function acceptContentType(operation) {
  const responses = operation.responses ?? {};
  for (const [status, response] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(status)) continue;
    const content = response?.content;
    if (!content) return null;
    const keys = Object.keys(content);
    return keys[0] ?? null;
  }
  return null;
}

/** The runtime operation table: what the client needs beyond the types. */
export function operationTable(document) {
  return listOperations(document).map(({ method, path: route, operation }) => ({
    method,
    path: route,
    body: requestContentType(operation),
    accept: acceptContentType(operation),
  }));
}

/**
 * Operation-level diff between two documents. `changed` compares the
 * operation object by value, so a description edit counts: the types
 * carry descriptions as JSDoc and a consumer reads them.
 */
export function diffOperations(before, after) {
  const key = (op) => `${op.method.toUpperCase()} ${op.path}`;
  const a = new Map(listOperations(before).map((op) => [key(op), op.operation]));
  const b = new Map(listOperations(after).map((op) => [key(op), op.operation]));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...a.keys()].filter(
    (k) => b.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)),
  );
  const schemasBefore = before.components?.schemas ?? {};
  const schemasAfter = after.components?.schemas ?? {};
  const schemas = [...new Set([...Object.keys(schemasBefore), ...Object.keys(schemasAfter)])]
    .filter((name) => JSON.stringify(schemasBefore[name]) !== JSON.stringify(schemasAfter[name]))
    .sort();
  return { added, removed, changed, schemas };
}

export function buildSnapshot(document, { source, fetchedAt, etag, lastModified }) {
  const operations = listOperations(document);
  return {
    snapshot: {
      source,
      fetched_at: fetchedAt,
      sha256: documentSha256(document),
      etag: etag ?? null,
      last_modified: lastModified ?? null,
      info: { title: document.info?.title ?? null, version: document.info?.version ?? null },
      paths: Object.keys(document.paths ?? {}).length,
      operations: operations.length,
      generator: `openapi-typescript@${generatorVersion()}`,
    },
    document,
  };
}

function generatorVersion() {
  // Resolve the installed copy (hoisted or not) rather than assuming a
  // node_modules layout; the package exports map hides package.json, so
  // walk up from the resolved entry point.
  let dir = path.dirname(createRequire(import.meta.url).resolve("openapi-typescript"));
  while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
}

function generatedHeader(snapshot, regenerate) {
  return [
    "// GENERATED FILE — do not edit.",
    `// Source: openapi-snapshot.json (sha256 ${snapshot.snapshot.sha256}, fetched ${snapshot.snapshot.fetched_at}`,
    `//         from ${snapshot.snapshot.source}, API ${snapshot.snapshot.info.version}).`,
    `// Regenerate: ${regenerate}`,
    "",
  ].join("\n");
}

/** The two generated sources as strings, from a snapshot object. */
export async function renderGenerated(snapshot) {
  // openapi-typescript keeps a per-process cache keyed on the object it
  // was handed; a structured clone keeps repeated renders in one process
  // (the tests) independent of each other.
  const ast = await openapiTS(structuredClone(snapshot.document), {
    // `never` for absent methods lets the client's path/method typing tell
    // "declared" from "absent" with a NonNullable<> check.
    alphabetize: false,
    defaultNonNullable: true,
  });
  const types = generatedHeader(snapshot, "npm run spec:generate (in packages/core)") + astToString(ast);

  const table = operationTable(snapshot.document);
  const rows = table.map(
    (op) =>
      `  { method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)}, ` +
      `body: ${JSON.stringify(op.body)}, accept: ${JSON.stringify(op.accept)} },`,
  );
  const operations =
    generatedHeader(snapshot, "npm run spec:generate (in packages/core)") +
    [
      'import type { ApiOperationRef } from "../api/types.js";',
      "",
      "/**",
      " * One row per operation in the snapshot. `satisfies` ties every row to",
      " * the generated `paths` type, so a row whose method/path the types do",
      " * not declare fails to compile — the two generated files cannot drift",
      " * from each other, and the coverage test compares this table with the",
      " * snapshot so neither drifts from the document.",
      " */",
      "export const API_OPERATIONS = [",
      ...rows,
      "] as const satisfies readonly ApiOperationRef[];",
      "",
    ].join("\n");

  return { types, operations };
}

// ---------------------------------------------------------------------------
// Filesystem + network
// ---------------------------------------------------------------------------

export function readSnapshot(file = SNAPSHOT_PATH) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed?.snapshot || !parsed?.document?.paths) {
    throw new Error(`${file} is not a snapshot ({ snapshot, document })`);
  }
  return parsed;
}

function writeSnapshot(snapshot, file = SNAPSHOT_PATH) {
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
}

export async function fetchServed(url = SPEC_URL) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const text = await res.text();
  const document = JSON.parse(text);
  if (!document.openapi || !document.paths) {
    throw new Error(`${url} did not return an OpenAPI document (no openapi/paths)`);
  }
  return {
    document,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
}

async function writeGenerated(snapshot) {
  const { types, operations } = await renderGenerated(snapshot);
  fs.mkdirSync(path.dirname(TYPES_PATH), { recursive: true });
  fs.writeFileSync(TYPES_PATH, types);
  fs.writeFileSync(OPERATIONS_PATH, operations);
}

async function generate() {
  const snapshot = readSnapshot();
  await writeGenerated(snapshot);
  console.log(
    `generate: ${snapshot.snapshot.operations} operations -> ${path.relative(PKG_ROOT, TYPES_PATH)}, ` +
      path.relative(PKG_ROOT, OPERATIONS_PATH),
  );
  return 0;
}

async function refresh() {
  const served = await fetchServed();
  const snapshot = buildSnapshot(served.document, {
    source: SPEC_URL,
    fetchedAt: new Date().toISOString(),
    etag: served.etag,
    lastModified: served.lastModified,
  });
  writeSnapshot(snapshot);
  await writeGenerated(snapshot);
  console.log(
    `refresh: snapshot ${snapshot.snapshot.sha256.slice(0, 12)} from ${SPEC_URL} ` +
      `(API ${snapshot.snapshot.info.version}, ${snapshot.snapshot.paths} paths, ` +
      `${snapshot.snapshot.operations} operations)`,
  );
  return 0;
}

function failure(lines) {
  console.error(lines.join("\n"));
  return 1;
}

async function check({ offline }) {
  const snapshot = readSnapshot();
  const rel = (p) => path.relative(PKG_ROOT, p);

  // 1. The snapshot is what it says it is.
  const actualSha = documentSha256(snapshot.document);
  if (actualSha !== snapshot.snapshot.sha256) {
    return failure([
      `spec:check: ${rel(SNAPSHOT_PATH)} was edited by hand.`,
      `  recorded sha256 ${snapshot.snapshot.sha256}`,
      `  document sha256 ${actualSha}`,
      "The snapshot is a copy of the served document, never a place to describe the API by hand.",
      "Accepted fix: `npm run sdk:spec:refresh` (rewrites the snapshot from the served document) and",
      "commit the resulting diff of the snapshot and src/generated/ together.",
    ]);
  }

  // 2. The generated files come from this snapshot.
  const rendered = await renderGenerated(snapshot);
  const stale = [];
  for (const [file, expected] of [
    [TYPES_PATH, rendered.types],
    [OPERATIONS_PATH, rendered.operations],
  ]) {
    const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (actual !== expected) stale.push(rel(file));
  }
  if (stale.length) {
    return failure([
      `spec:check: generated files differ from what ${rel(SNAPSHOT_PATH)} generates: ${stale.join(", ")}.`,
      "Either the snapshot changed without regenerating, or a generated file was edited by hand.",
      "Neither a hand edit of src/generated/ nor a hand edit of the snapshot is accepted.",
      "Accepted fix: `npm run sdk:spec:generate` (in this package, `npm run spec:generate`) and commit the output.",
    ]);
  }

  if (offline) {
    console.log(
      `spec:check: snapshot ${snapshot.snapshot.sha256.slice(0, 12)} and generated files agree ` +
        `(${snapshot.snapshot.operations} operations); served document not compared (--offline).`,
    );
    return 0;
  }

  // 3. The served document has not moved.
  let served;
  try {
    served = await fetchServed();
  } catch (err) {
    console.error(`spec:check: could not fetch ${SPEC_URL}: ${err?.message ?? err}`);
    console.error("Exit 2: the served document was not compared. This is not a pass.");
    return 2;
  }
  const servedSha = documentSha256(served.document);
  if (servedSha === snapshot.snapshot.sha256) {
    console.log(
      `spec:check: served document equals snapshot ${servedSha.slice(0, 12)} ` +
        `(API ${snapshot.snapshot.info.version}, ${snapshot.snapshot.operations} operations, ` +
        `snapshot fetched ${snapshot.snapshot.fetched_at}).`,
    );
    return 0;
  }

  const diff = diffOperations(snapshot.document, served.document);
  const servedOps = listOperations(served.document).length;
  const lines = [
    `spec:check: ${rel(SNAPSHOT_PATH)} differs from ${SPEC_URL}.`,
    `  snapshot: sha256 ${snapshot.snapshot.sha256.slice(0, 12)}  API ${snapshot.snapshot.info.version}  ` +
      `${snapshot.snapshot.operations} operations  fetched ${snapshot.snapshot.fetched_at}`,
    `  served:   sha256 ${servedSha.slice(0, 12)}  API ${served.document.info?.version ?? "?"}  ` +
      `${servedOps} operations`,
    ...diff.added.map((k) => `  + ${k}`),
    ...diff.removed.map((k) => `  - ${k}`),
    ...diff.changed.map((k) => `  ~ ${k}`),
    ...diff.schemas.map((k) => `  ~ components.schemas.${k}`),
  ];
  if (!diff.added.length && !diff.removed.length && !diff.changed.length && !diff.schemas.length) {
    lines.push("  (difference is outside paths/components.schemas: info, servers or security)");
  }
  if (servedOps < snapshot.snapshot.operations) {
    lines.push(
      "The served document has FEWER operations than the snapshot. Before refreshing, rule out a",
      "cached proxy body or a rolled-back deploy: a refresh here would delete client surface that",
      "the API still has.",
    );
  }
  lines.push(
    "Editing the snapshot to match, or skipping this check, is not accepted.",
    "Accepted fix: `npm run sdk:spec:refresh`, then review the diff of the snapshot and src/generated/",
    "on its own and commit it with whatever client change it forces. Evidence for the PR: that",
    "commit, plus `npm run sdk:spec:check` exiting 0 against the served document.",
  );
  return failure(lines);
}

async function main(argv) {
  const [mode, ...flags] = argv;
  const offline = flags.includes("--offline");
  switch (mode) {
    case "generate":
      return generate();
    case "refresh":
      return refresh();
    case "check":
      return check({ offline });
    default:
      console.error("usage: openapi-spec.mjs <generate|refresh|check [--offline]>");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack ?? String(err));
      process.exit(2);
    },
  );
}
