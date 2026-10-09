/**
 * What the kit says about a mandate after it was revoked: `inspect` on the
 * run that met the revocation, and the consent that replaces the mandate.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "@codespar/sdk";
import { ProofBundle, loadMandate, type Mandate } from "@codespar/agent-core";
import { assembleTimeline, loadScenario, renderText, runScenario } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { runEmbeddedConsent } from "../src/modules/embedded-consent.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");

describe("npm run inspect on the run that met a revocation", () => {
  it("the header says revoked, from the source that answered, and no longer says active", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "bills-inspect-revoked-"));
    const run = await runScenario(agent, loadScenario(agent, "mandate-revoked"), { mode: "human", runsDir });
    const text = renderText(assembleTimeline(ProofBundle.open(runsDir, run.run_id)!));
    const header = text.split("\n")[2]!;

    // The line two below it, which the header used to contradict.
    expect(text).toMatch(/was revoked \(source: stub\)/);
    expect(header).toMatch(/^ {2}mandate revoked \(source: stub, \d\d:\d\d:\d\d; active in the snapshot at the start of the run\), expires /);
    expect(text).not.toMatch(/^ {2}mandate active,/m);
  });

  it("a run that met none still says active", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "bills-inspect-active-"));
    const run = await runScenario(agent, loadScenario(agent, "happy-path"), { mode: "human", runsDir });
    expect(renderText(assembleTimeline(ProofBundle.open(runsDir, run.run_id)!)).split("\n")[2]).toMatch(/^ {2}mandate active, expires /);
  });
});

/** The four calls a consent makes, answered as the sandbox answers them; `status` is what `GET /v1/mandates/{id}` says of the mandate the file already holds. */
function fakeApi(example: Mandate, status: string | Error): { api: ApiClient; reads: string[] } {
  const reads: string[] = [];
  const api = {
    post: async (path: string) => {
      if (path === "/v1/consents/init") return { token: "tok_test", expires_at: "2026-09-23T18:30:00.000Z" };
      if (path === "/v1/consents/{token}/submit") {
        return {
          mandate_id: "cm_new",
          signature: "0".repeat(64),
          mandate: { consumer_id: example.consumer_id, agent_id: example.agent_id, purpose: example.purpose, currency: "BRL", cap_minor: example.cap_minor, per_tx_cap_minor: example.per_tx_cap_minor, merchant_pin_kind: "pix-key", merchant_allowlist: example.beneficiaries.map((b) => b.payee), expires_at: 1821312000 },
        };
      }
      return { amount_minor: 600000, account: "acc_test", deposit_id: "dep_test" };
    },
    get: async (_path: string, options: { path: { id: string } }) => {
      reads.push(options.path.id);
      if (status instanceof Error) throw status;
      return { status, expires_at: "2027-09-23T00:00:00.000Z", org_paused: false };
    },
  };
  return { api: api as unknown as ApiClient, reads };
}

describe("npm run consent", () => {
  const example = loadMandate(join(AGENT_DIR, "mandate.example.json"));
  const NOT_YET = "O mandato ainda não existe.";

  async function consent(options: { previous?: Mandate; status?: string | Error; locale?: "pt-BR" | "en" }) {
    const dir = mkdtempSync(join(tmpdir(), "bills-consent-"));
    const mandatePath = join(dir, ".codespar", "mandate.json");
    if (options.previous) {
      mkdirSync(join(dir, ".codespar"));
      writeFileSync(mandatePath, JSON.stringify(options.previous));
    }
    const said: string[] = [];
    const { api, reads } = fakeApi(example, options.status ?? "active");
    const mandate = await runEmbeddedConsent({ api, example, mandatePath, say: (l) => said.push(l), confirm: async () => true, now: () => new Date("2026-09-23T18:00:00.000Z"), ...(options.locale ? { locale: options.locale } : {}) });
    return { said, reads, mandate, mandatePath, file: relative(process.cwd(), mandatePath) };
  }

  it("with no mandate in the file, says it does not exist yet and reads no status", async () => {
    const out = await consent({});
    expect(out.said[1]).toContain(NOT_YET);
    expect(out.reads).toEqual([]);
  });

  it("after a revocation, names the revoked mandate the file holds instead of saying none exists", async () => {
    const previous = { ...example, id: "cm_old" };
    const out = await consent({ previous, status: "revoked" });
    expect(out.reads).toEqual(["cm_old"]);
    expect(out.said[1]).toBe(`Já existe um mandato em ${out.file}: cm_old, revogado na API. Este é o consentimento de um mandato novo, que passa a ser o do arquivo (sandbox):`);
    expect(out.said.join("\n")).not.toContain(NOT_YET);
    // And the file is the new mandate's afterwards, as the line said.
    expect((JSON.parse(readFileSync(out.mandatePath, "utf8")) as { id: string }).id).toBe("cm_new");
    expect(out.mandate.id).toBe("cm_new");
  });

  it("says the state the API answers, whatever it is, and says so when it does not answer", async () => {
    const previous = { ...example, id: "cm_old" };
    expect((await consent({ previous, status: "active" })).said[1]).toContain("cm_old, ativo na API.");
    expect((await consent({ previous, status: "paused" })).said[1]).toContain("cm_old, pausado na API.");
    expect((await consent({ previous, status: new Error("ECONNRESET") })).said[1]).toContain("cm_old, com estado que a API não respondeu.");
    expect((await consent({ previous, status: "revoked", locale: "en" })).said[1]).toContain("already holds a mandate: cm_old, revoked on the API.");
  });

  it("a file it cannot read does not stop a new consent", async () => {
    const out = await consent({ previous: { id: "not a mandate" } as unknown as Mandate });
    expect(out.said[1]).toContain(NOT_YET);
    expect(out.mandate.id).toBe("cm_new");
  });
});
