/**
 * The header of `inspect` and the mandate's status. The snapshot in the
 * bundle is the local copy at the start of the run and says `active` for a
 * mandate the API answered was revoked two lines below; the header says what
 * a gate of the run heard, when that is the last word the run has.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProofBundle } from "@codespar/agent-core";
import { assembleTimeline, renderHtml, renderText } from "../src/inspect.js";

const AGENT = { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo_titular" };
const SNAPSHOT = "active in the snapshot at the start of the run";

type Step = { execution: string | null; to?: string; reason?: string; detail?: string; at: string };

function bundleOf(steps: Step[]): ProofBundle {
  const bundle = new ProofBundle(mkdtempSync(join(tmpdir(), "inspect-mandate-status-")), "run_status_mandate_abc123");
  bundle.meta({ run_id: bundle.runId, agent: "bills-agent@0.1.0", mode: "mandate", rail: "api", mandate_id: "cm_fixture", mandate_version: 1, started_at: "2026-09-23T18:00:00.000Z" });
  writeFileSync(join(bundle.dir, "mandate.snapshot.json"), JSON.stringify({ id: "cm_fixture", version: 1, status: "active", currency: "BRL", cap_minor: 7200000, per_tx_cap_minor: 250000, expires_at: "2027-09-23T00:00:00.000Z", beneficiaries: [] }));
  steps.forEach((step, i) => {
    const payload = { ...(step.to ? { from: "approved", to: step.to, at: step.at, actor: AGENT } : {}), ...(step.reason ? { reason: step.reason } : {}), ...(step.detail ? { detail: step.detail } : {}) };
    bundle.event({ seq: i + 1, run_id: bundle.runId, execution_id: step.execution, type: step.to ? "execution.transition" : "execution.refused_before_draft", payload, at: step.at, actor: AGENT });
  });
  return bundle;
}

const header = (bundle: ProofBundle) => renderText(assembleTimeline(bundle)).split("\n")[2];

describe("inspect: the mandate's status in the header", () => {
  it("is the snapshot's when no gate of the run heard otherwise", () => {
    const bundle = bundleOf([
      { execution: "exe_a", to: "executing", at: "2026-09-23T18:00:10.000Z" },
      { execution: "exe_a", to: "settled", at: "2026-09-23T18:00:12.000Z" },
    ]);
    expect(assembleTimeline(bundle).mandate?.status_seen).toBeNull();
    expect(header(bundle)).toMatch(/^ {2}mandate active, expires 2027-09-23T00:00:00.000Z · /);
  });

  it("is what the API answered at the gate, with the source, the time and what the snapshot had said", () => {
    const bundle = bundleOf([{ execution: "exe_a", to: "denied", reason: "mandate_revoked", detail: "mandate cm_fixture was revoked (source: api)", at: "2026-09-23T18:00:13.000Z" }]);
    const report = assembleTimeline(bundle);
    expect(report.mandate).toMatchObject({ status: "active", status_seen: { status: "revoked", source: "api", at: "2026-09-23T18:00:13.000Z" } });
    expect(header(bundle)).toContain(`mandate revoked (source: api, 18:00:13; ${SNAPSHOT}), expires `);
    expect(header(bundle)).not.toContain("mandate active,");
    // The page says the same thing as the terminal.
    expect(renderHtml(report)).toContain(`mandate revoked (source: api, 18:00:13; ${SNAPSHOT}), expires `);
    expect(renderHtml(report)).not.toContain("mandate active,");
  });

  it("reads a refusal before a draft the same way, and a paused mandate, and the stub", () => {
    const refused = bundleOf([{ execution: null, reason: "mandate_revoked", detail: "mandate cm_fixture was revoked (source: stub)", at: "2026-09-23T18:02:00.000Z" }]);
    expect(header(refused)).toContain(`mandate revoked (source: stub, 18:02:00; ${SNAPSHOT})`);
    const paused = bundleOf([{ execution: "exe_a", to: "denied", reason: "mandate_paused", detail: "mandate cm_fixture is paused (source: api)", at: "2026-09-23T18:00:13.000Z" }]);
    expect(header(paused)).toContain(`mandate paused (source: api, 18:00:13; ${SNAPSHOT})`);
  });

  it("an expiry the run's own clock found names the clock, not a source that never answered it", () => {
    const bundle = bundleOf([{ execution: "exe_a", to: "expired", reason: "mandate_expired", detail: "mandate cm_fixture expired at 2027-09-23T00:00:00.000Z", at: "2027-09-23T00:00:05.000Z" }]);
    expect(assembleTimeline(bundle).mandate?.status_seen).toMatchObject({ status: "expired", source: null });
    expect(header(bundle)).toContain(`mandate expired (by the run's clock, 00:00:05; ${SNAPSHOT})`);
  });

  it("a payment that executed after a pause is the last word: the mandate was resumed, and the header is the snapshot's again", () => {
    const bundle = bundleOf([
      { execution: "exe_a", to: "denied", reason: "mandate_paused", detail: "mandate cm_fixture is paused (source: api)", at: "2026-09-23T18:00:13.000Z" },
      { execution: "exe_b", to: "executing", at: "2026-09-23T18:05:00.000Z" },
      { execution: "exe_b", to: "settled", at: "2026-09-23T18:05:02.000Z" },
    ]);
    expect(assembleTimeline(bundle).mandate?.status_seen).toBeNull();
    expect(header(bundle)).toContain("mandate active, expires ");
  });

  it("a refusal that is not about the mandate's status leaves the header alone", () => {
    const bundle = bundleOf([{ execution: "exe_a", to: "denied", reason: "cap_exceeded", detail: "300000 is above the cap per payment", at: "2026-09-23T18:00:13.000Z" }]);
    expect(assembleTimeline(bundle).mandate?.status_seen).toBeNull();
  });
});
