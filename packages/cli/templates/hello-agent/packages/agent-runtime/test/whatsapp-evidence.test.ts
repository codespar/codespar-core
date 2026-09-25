/**
 * Decision 19a: `attestation.evidence` on the consent submit, built from what
 * a conversation channel can honestly say it observed (ent#1615).
 *
 * The first test is the important one and it asserts a REFUSAL. A simulated
 * conversation was observed by nobody, and signing a counter as a provider
 * message id would put a made-up fact inside a record whose whole value is
 * that it is observed. The seam is wired; the simulator declines to use it.
 *
 * The rest hold the shape to the API's own rule, so a change here fails in
 * the repo instead of failing as a 400 at the consent submit.
 */
import { describe, expect, it } from "vitest";
import { evidenceFor, WHATSAPP_EVIDENCE_KEYS } from "../src/channels/whatsapp/evidence.js";
import type { InboundMessage } from "../src/channels/types.js";

const AT = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = () => new Date("2026-09-23T17:00:00Z");
const REAL: InboundMessage = {
  id: "wamid.HBgNNTUxMTk4NzY1NDMyMRUCABIYEjND",
  from: "+5511987654321",
  text: "sim, autorizo",
  timestamp: AT("2026-09-23T17:00:00Z"),
};

describe("what an emulated conversation may attest", () => {
  it("refuses, and says why in a sentence somebody can act on", () => {
    const result = evidenceFor({ live: false, message: { ...REAL, id: "wamid.sim.9f1c" }, now: NOW });
    expect(result.attestable).toBe(false);
    if (result.attestable) return;
    expect(result.reason).toContain("emulator");
    expect(result.reason).toContain("no phone was involved");
  });

  it("refuses even when the emulated message wears a provider-shaped id, because the id is not what decides", () => {
    expect(evidenceFor({ live: false, message: REAL, now: NOW }).attestable).toBe(false);
  });
});

describe("what a live conversation attests", () => {
  it("builds the submit's attestation with the four keys the whatsapp channel may carry", () => {
    const result = evidenceFor({ live: true, message: REAL, sessionId: "conv_1042", reference: "acordo-1042", now: NOW });
    expect(result.attestable).toBe(true);
    if (!result.attestable) return;
    expect(result.attestation).toEqual({
      method: "partner_session",
      asserted_at: AT("2026-09-23T17:00:00Z"),
      reference: "acordo-1042",
      evidence: {
        channel: "whatsapp",
        contact: "+5511987654321",
        message_id: "wamid.HBgNNTUxMTk4NzY1NDMyMRUCABIYEjND",
        session_id: "conv_1042",
        provider_ts: AT("2026-09-23T17:00:00Z"),
      },
    });
  });

  it("carries the contact in the clear, because the API hashes it under a key a partner cannot compute", () => {
    const result = evidenceFor({ live: true, message: REAL, now: NOW });
    if (!result.attestable) throw new Error("expected evidence");
    expect(result.attestation.evidence.contact).toBe("+5511987654321");
    expect(result.attestation.evidence).not.toHaveProperty("contact_hash");
  });

  it("never carries an ip, a user agent, a device id or a geo: on this channel each of those was inferred", () => {
    const result = evidenceFor({ live: true, message: REAL, now: NOW });
    if (!result.attestable) throw new Error("expected evidence");
    const keys = Object.keys(result.attestation.evidence).filter((k) => k !== "channel");
    expect(keys.every((k) => (WHATSAPP_EVIDENCE_KEYS as readonly string[]).includes(k))).toBe(true);
    for (const forbidden of ["ip", "user_agent", "device_id_hash", "geo"]) expect(result.attestation.evidence).not.toHaveProperty(forbidden);
  });

  it("separates the partner's clock from the provider's: asserted_at is ours, provider_ts is theirs", () => {
    const result = evidenceFor({ live: true, message: { ...REAL, timestamp: AT("2026-09-23T15:00:00Z") }, now: () => new Date("2026-09-23T17:00:05Z") });
    if (!result.attestable) throw new Error("expected evidence");
    expect(result.attestation.asserted_at).toBe(AT("2026-09-23T17:00:05Z"));
    expect(result.attestation.evidence.provider_ts).toBe(AT("2026-09-23T15:00:00Z"));
  });

  it("refuses a reference with a dot: the canonical signing string joins segments, and a wamid goes in message_id", () => {
    const result = evidenceFor({ live: true, message: REAL, reference: "wamid.HBgN", now: NOW });
    expect(result.attestable).toBe(false);
  });

  it("refuses a message id or a session id the API's opaque-id shape would reject", () => {
    expect(evidenceFor({ live: true, message: { ...REAL, id: "wamid with spaces" }, now: NOW }).attestable).toBe(false);
    expect(evidenceFor({ live: true, message: REAL, sessionId: "conv 1042", now: NOW }).attestable).toBe(false);
  });

  it("refuses a message the provider gave no timestamp for", () => {
    expect(evidenceFor({ live: true, message: { ...REAL, timestamp: 0 }, now: NOW }).attestable).toBe(false);
  });
});
