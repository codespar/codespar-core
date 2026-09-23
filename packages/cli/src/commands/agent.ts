/**
 * `codespar agent run <dir>` and `codespar eval <dir>`: the CLI as the home
 * of the agent commands (agent-starter-kits, spec v5.1.1 §14.4–14.5).
 *
 * Neither command re-implements the runtime. An agent directory built on
 * `@codespar/agent-core` already carries its own entry (`npm start`) and its
 * own gates (`npm run check`, `npm run eval`); the CLI resolves the
 * directory's manifest, refuses what is not a `schema: 1` agent, and
 * delegates to those scripts with the same arguments. That is what makes
 * `codespar agent run <dir> --input X` and `npm start -- --input X` the same
 * command: one process, one output.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "../config.js";
import { c, info, json } from "../output.js";

/** `agent.yaml` schema this CLI knows how to run. */
export const SUPPORTED_MANIFEST_SCHEMA = 1;

export interface ResolvedAgent {
  /** Absolute agent directory. */
  dir: string;
  /** Absolute path of `agent.yaml`. */
  manifestPath: string;
  name: string | null;
  version: string | null;
  /** The `scripts` of the directory's package.json. */
  scripts: Record<string, string>;
}

/**
 * The top-level scalar fields of a YAML document: `key: value` lines at
 * column zero, comments and quotes stripped.
 *
 * Deliberately not a YAML parser. The CLI needs three fields to decide
 * whether a directory is an agent it can run — `schema`, `name`,
 * `version` — and all three are top-level scalars by the manifest schema
 * (`packages/agent-core/src/manifest.ts` in agent-starter-kits). Full
 * validation of the manifest is `npm run check`'s job, which `codespar
 * eval` runs; pulling a YAML dependency into the CLI to read three lines
 * would be a runtime dependency for nothing.
 */
export function topLevelScalars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    // Strip a trailing comment. A `#` inside quotes is part of the value.
    const quoted = /^(["'])(.*?)\1/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (value !== "") out[m[1]!] = value;
  }
  return out;
}

/**
 * Resolve an agent directory: it exists, it carries an `agent.yaml` that
 * declares `schema: 1`, and it has a package.json with scripts to delegate
 * to. Each refusal has a stable `code` so a script can tell "not an agent
 * directory" from "an agent of a schema this CLI does not know".
 */
export function resolveAgentDir(input: string): ResolvedAgent {
  const dir = resolve(input);
  const manifestPath = join(dir, "agent.yaml");
  if (!existsSync(manifestPath)) {
    throw new CliError(
      `${dir} has no agent.yaml. \`codespar agent run\` and \`codespar eval\` take an agent directory built on @codespar/agent-core (schema: 1).`,
      { code: "agent_manifest_missing" },
    );
  }
  const fields = topLevelScalars(readFileSync(manifestPath, "utf8"));
  const schema = fields["schema"];
  if (schema === undefined) {
    throw new CliError(`${manifestPath} declares no \`schema\`; this CLI runs schema ${SUPPORTED_MANIFEST_SCHEMA}.`, {
      code: "agent_manifest_schema_missing",
    });
  }
  if (Number(schema) !== SUPPORTED_MANIFEST_SCHEMA) {
    throw new CliError(
      `${manifestPath} declares schema ${schema}; this CLI runs schema ${SUPPORTED_MANIFEST_SCHEMA}. Upgrade @codespar/cli, or pin the one agent.yaml names.`,
      { code: "agent_manifest_unsupported_schema" },
    );
  }

  const packagePath = join(dir, "package.json");
  if (!existsSync(packagePath)) {
    throw new CliError(`${dir} has no package.json; the agent's entry is its \`npm start\`.`, {
      code: "agent_package_missing",
    });
  }
  let scripts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
    scripts = parsed.scripts ?? {};
  } catch {
    throw new CliError(`${packagePath} is not valid JSON.`, { code: "agent_package_invalid" });
  }

  return {
    dir,
    manifestPath,
    name: fields["name"] ?? null,
    version: fields["version"] ?? null,
    scripts,
  };
}

function requireScript(agent: ResolvedAgent, script: string): void {
  if (!agent.scripts[script]) {
    throw new CliError(
      `${agent.dir}/package.json has no \`${script}\` script. An agent directory delegates to \`npm run ${script}\`; add it, or run inside an agent built on @codespar/agent-core.`,
      { code: "agent_script_missing" },
    );
  }
}

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * `npm run <script> --silent -- <args>` in the agent directory.
 *
 * `--silent` matters for `--json`: without it npm prints its
 * `> name@version start` banner on STDOUT, ahead of the agent's document,
 * and the contract is valid JSON and nothing else there.
 */
function npmArgs(script: string, args: readonly string[]): string[] {
  return ["run", script, "--silent", "--", ...args];
}

function spawnScript(
  agent: ResolvedAgent,
  script: string,
  args: readonly string[],
  stdout: "inherit" | "pipe",
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn(NPM, npmArgs(script, args), {
      cwd: agent.dir,
      stdio: ["inherit", stdout, "inherit"],
      shell: process.platform === "win32",
    });
    let captured = "";
    child.stdout?.on("data", (chunk) => (captured += String(chunk)));
    child.on("error", fail);
    child.on("close", (status, signal) => done({ status, signal, stdout: captured }));
  });
}

/* ── agent run ────────────────────────────────────────────────────── */

export interface AgentRunOptions {
  input?: string;
  approve?: boolean;
  deny?: boolean;
  json?: boolean;
}

/**
 * The argument list handed to the agent's entry: the CLI's flags in the
 * spelling `src/main.ts` of a kit agent parses. Pure, so the mapping is
 * testable without a process.
 */
export function agentRunArgs(opts: AgentRunOptions): string[] {
  if (opts.approve && opts.deny) {
    throw new CliError("--approve and --deny are mutually exclusive.", { code: "agent_decision_conflict" });
  }
  const args: string[] = [];
  if (opts.input !== undefined) args.push("--input", opts.input);
  if (opts.approve) args.push("--approve");
  if (opts.deny) args.push("--deny");
  if (opts.json) args.push("--json");
  return args;
}

/**
 * Run one turn (or the interactive terminal, without `--input`) of the
 * agent in `dir`, through its own `npm start`. stdout and stderr are the
 * child's, untouched: with `--json` the document on stdout is the agent's
 * own, and the exit code is the agent's own (a kit agent answers 3 when an
 * execution is still in flight).
 */
export async function agentRunCommand(dir: string, opts: AgentRunOptions): Promise<number> {
  const agent = resolveAgentDir(dir);
  requireScript(agent, "start");
  const args = agentRunArgs(opts);
  if (!opts.json) {
    info(`${agent.name ?? "agent"}${agent.version ? `@${agent.version}` : ""} — npm start${args.length ? ` -- ${args.join(" ")}` : ""}`);
  }
  const result = await spawnScript(agent, "start", args, "inherit");
  if (result.status === null) {
    throw new CliError(`the agent's \`npm start\` was terminated by ${result.signal ?? "a signal"}.`, {
      code: "agent_terminated",
    });
  }
  return result.status;
}

/* ── eval ─────────────────────────────────────────────────────────── */

export interface EvalCase {
  suite: "check" | "adversarial" | "scenario";
  name: string;
  mode?: string;
  ok: boolean;
  failures: string[];
}

export interface EvalReport {
  ok: boolean;
  agent: string | null;
  cases: EvalCase[];
  /** `npm run check --json` verbatim. */
  check: unknown;
  /** `npm run eval --json` verbatim. */
  eval: unknown;
}

interface CheckDocument {
  ok?: boolean;
  agent?: string | null;
  findings?: Array<{ level?: string; code?: string; message?: string }>;
}

interface EvalDocument {
  ok?: boolean;
  adversarial?: Array<{ name?: string; ok?: boolean; failures?: string[] }>;
  scenarios?: Array<{ name?: string; mode?: string; ok?: boolean; failures?: string[] }>;
}

function parseDocument(script: string, stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") {
    throw new CliError(`\`npm run ${script} -- --json\` wrote nothing on stdout; expected one JSON document.`, {
      code: "agent_eval_unreadable",
    });
  }
  // The document is the LAST line: a script that also prints its human lines
  // on stdout still ends with the machine one.
  const last = text.split("\n").filter((line) => line.trim() !== "").at(-1)!;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    throw new CliError(`\`npm run ${script} -- --json\` did not end with a JSON document on stdout.`, {
      code: "agent_eval_unreadable",
    });
  }
}

/**
 * Flatten the two documents into one case list. Pure: the process-free
 * half of `codespar eval`, and the one the unit tests pin.
 *
 * The manifest check is ONE case, `check/<agent>`, whose failures are its
 * error findings; warnings never fail it, matching `checkAgent`. A
 * scenario runs once per mode it declares, and each run is its own case.
 */
export function summariseEval(check: unknown, evaluation: unknown): EvalReport {
  const checkDoc = (check ?? {}) as CheckDocument;
  const evalDoc = (evaluation ?? {}) as EvalDocument;
  const agent = checkDoc.agent ?? null;

  const cases: EvalCase[] = [];
  const errors = (checkDoc.findings ?? []).filter((f) => f.level === "error");
  cases.push({
    suite: "check",
    name: agent ?? "agent.yaml",
    ok: checkDoc.ok === true,
    failures: errors.map((f) => `${f.code ?? "error"}: ${f.message ?? ""}`.trim()),
  });
  for (const r of evalDoc.adversarial ?? []) {
    cases.push({ suite: "adversarial", name: r.name ?? "?", ok: r.ok === true, failures: r.failures ?? [] });
  }
  for (const r of evalDoc.scenarios ?? []) {
    cases.push({
      suite: "scenario",
      name: r.name ?? "?",
      ...(r.mode === undefined ? {} : { mode: r.mode }),
      ok: r.ok === true,
      failures: r.failures ?? [],
    });
  }
  // `ok` is the AND of the cases AND of the documents' own verdicts: a
  // document that says `ok: false` with no listed failure is still a failure.
  const ok = cases.every((k) => k.ok) && checkDoc.ok === true && evalDoc.ok === true;
  return { ok, agent, cases, check, eval: evaluation };
}

function caseLabel(k: EvalCase): string {
  return `${k.suite}/${k.name}${k.mode ? ` [${k.mode}]` : ""}`;
}

/**
 * Run the agent's manifest check and its eval suite (adversarial cases plus
 * every scenario in every mode it declares), and report per case. Both
 * scripts run even when the first fails, so one invocation shows the whole
 * picture. Exit 1 on any failing case.
 */
export async function evalCommand(dir: string, opts: { json?: boolean }): Promise<number> {
  const agent = resolveAgentDir(dir);
  requireScript(agent, "check");
  requireScript(agent, "eval");

  if (!opts.json) info(`${agent.name ?? "agent"}${agent.version ? `@${agent.version}` : ""} — npm run check, npm run eval`);
  const checkRun = await spawnScript(agent, "check", ["--json"], "pipe");
  const evalRun = await spawnScript(agent, "eval", ["--json"], "pipe");
  const report = summariseEval(parseDocument("check", checkRun.stdout), parseDocument("eval", evalRun.stdout));

  if (opts.json) {
    json(report);
  } else {
    for (const k of report.cases) {
      const mark = k.ok ? c.green("ok  ") : c.red("FAIL");
      process.stdout.write(`${mark} ${caseLabel(k)}${k.failures.length ? ` — ${k.failures.join("; ")}` : ""}\n`);
    }
    const failed = report.cases.filter((k) => !k.ok).length;
    process.stdout.write(
      report.ok
        ? `${c.green("✓")} ${report.cases.length} case(s) passed\n`
        : `${c.red("✗")} ${failed} of ${report.cases.length} case(s) failed\n`,
    );
  }
  return report.ok ? 0 : 1;
}
