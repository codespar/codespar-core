/**
 * #64 on the approval path: the locale changes what the titular READS and
 * nothing about what their answer DECIDES. The same answer to the pt-BR
 * question and to the English one ends in the same state, and the approval
 * artifact names the same approver.
 *
 * And the resolution, end to end: `--locale` beats `agent.yaml`, which beats
 * the default, and the run's bundle records the locale it ran in.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock, type Locale } from "@codespar/agent-core";
import { handleExecution, parseApproval, setup, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const APPROVER = { id: "usr_demo_titular", channel: "terminal" };
/** Every answer the `[s/N]` parser has a rule for, both languages, plus what falls through to no. */
const ANSWERS = ["s", "sim", "y", "yes", " SIM ", "Yes", "n", "nao", "não", "no", "", "talvez", "si"];

function open(locale: Locale | undefined, dir = AGENT_DIR): Setup {
  return setup(dir === AGENT_DIR ? agent : { ...agent, dir }, {
    mode: "human",
    rail: "stub",
    provider: "replay",
    runsDir: mkdtempSync(join(tmpdir(), "bills-locale-runs-")),
    stateDir: mkdtempSync(join(tmpdir(), "bills-locale-state-")),
    now: fixedClock("2026-09-23T14:00:00-03:00"),
    say: () => undefined,
    ...(locale ? { locale } : {}),
  });
}

/** Proposes one payment and answers the approval question with `answer`; returns the final state, the question asked and the console. */
async function decideOnce(locale: Locale, answer: string) {
  const s = open(locale);
  const asked: string[] = [];
  const said: string[] = [];
  try {
    const draft = await s.engine.draft({ items: [{ payee: "escola", amount: 185000, description: "mensalidade de outubro" }] });
    if (!draft.ok) throw new Error(draft.reason);
    const final = await handleExecution(draft.execution, {
      setup: s,
      approver: APPROVER,
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
      say: (l) => void said.push(l),
    });
    const approvers = s.bundle.readApprovals().map((a) => a.approver);
    return { state: final.state, asked, said, approvers };
  } finally {
    s.close();
  }
}

describe("the approval question decides the same in both locales", () => {
  it.each(ANSWERS)("answer %j", async (answer) => {
    const pt = await decideOnce("pt-BR", answer);
    const en = await decideOnce("en", answer);
    // What was shown differs...
    expect(pt.asked).toEqual(["  Aprovar este pagamento? [s/N] "]);
    expect(en.asked).toEqual(["  Approve this payment? [y/N] "]);
    // ...and what was decided does not.
    expect(en.state).toBe(pt.state);
    expect(en.approvers).toEqual(pt.approvers);
    expect(pt.state).toBe(parseApproval(answer) === "approve" ? "settled" : "denied");
  });

  it("prints the execution in the run's locale, accents included", async () => {
    const pt = await decideOnce("pt-BR", "s");
    const en = await decideOnce("en", "y");
    expect(pt.said.join("\n")).toContain("execução exe_");
    expect(pt.said.join("\n")).toContain("total (calculado pelo core): R$ 1.850,00");
    expect(pt.said.join("\n")).toMatch(/recibo: /);
    expect(en.said.join("\n")).toContain("execution exe_");
    expect(en.said.join("\n")).toContain("total (computed by the core): R$1,850.00");
    expect(en.said.join("\n")).toMatch(/receipt: /);
  });
});

describe("which locale a run speaks", () => {
  function copyWithLocale(locale: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "bills-locale-agent-"));
    cpSync(AGENT_DIR, dir, { recursive: true, filter: (src) => !/node_modules|\/runs|\.codespar/.test(src) });
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf8").replace(/^locale:.*\n/m, locale ? `locale: ${locale}\n` : "");
    writeFileSync(join(dir, "agent.yaml"), yaml);
    return dir;
  }

  it("is --locale, else agent.yaml's locale, else pt-BR; and the bundle records it", () => {
    const cases: Array<[string | undefined, Locale | undefined, Locale]> = [
      [undefined, undefined, "pt-BR"],
      ["en", undefined, "en"],
      ["en", "pt-BR", "pt-BR"],
      ["pt-BR", "en", "en"],
    ];
    for (const [manifest, flag, expected] of cases) {
      const s = open(flag, copyWithLocale(manifest));
      try {
        expect(s.locale).toBe(expected);
        expect(s.bundle.readMeta()?.["locale"]).toBe(expected);
        expect(s.strings).toBe(agent.kit.strings[expected]);
      } finally {
        s.close();
      }
    }
  });

  function run(args: string[]) {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-locale-cli-"));
    const result = spawnSync(NODE, [BIN, "start", ...args], {
      cwd: AGENT_DIR,
      env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    const runs = join(stateDir, "runs");
    let meta: Record<string, unknown> | undefined;
    try {
      const [dir] = readdirSync(runs);
      meta = JSON.parse(readFileSync(join(runs, dir!, "run.json"), "utf8")) as Record<string, unknown>;
    } catch {
      meta = undefined;
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, meta };
  }

  it("`npm start -- --locale en` prints the code's lines in English and pays the same", () => {
    const pt = run(["--input", "pague a escola de outubro", "--approve", "--json"]);
    const en = run(["--input", "pague a escola de outubro", "--approve", "--json", "--locale", "en"]);
    expect(pt.code).toBe(0);
    expect(en.code).toBe(0);
    expect(pt.stderr).toContain("execução");
    expect(pt.stderr).toContain("calculado pelo core");
    expect(en.stderr).toContain("execution");
    expect(en.stderr).toContain("computed by the core");
    expect(en.stderr).not.toContain("execução");
    expect(pt.meta?.["locale"]).toBe("pt-BR");
    expect(en.meta?.["locale"]).toBe("en");
    // The machine output is the same contract in both: same states, same receipts, no locale-dependent field.
    const shape = (o: string) => {
      const p = JSON.parse(o) as { executions: Array<{ state: string; total_minor: number; receipt_ids: string[] }> };
      return p.executions.map((e) => ({ state: e.state, total_minor: e.total_minor, receipts: e.receipt_ids.length }));
    };
    expect(shape(en.stdout)).toEqual(shape(pt.stdout));
  });

  it("an unknown --locale is a usage error, before anything runs", () => {
    const out = run(["--input", "pague a escola de outubro", "--locale", "es"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--locale must be pt-BR or en");
    expect(out.meta).toBeUndefined();
  });
});
