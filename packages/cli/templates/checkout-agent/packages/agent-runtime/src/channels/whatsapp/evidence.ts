/**
 * Decision 19a, the part a channel can carry: `attestation.evidence` on
 * `POST /v1/consents/{token}/submit` (codespar-enterprise ent#1615).
 *
 * In the sandbox a mandate is born at the terminal with
 * `attestation: { method: "in_person" }` — the titular is at the keyboard and
 * the partner is the process. In production the act happens in a
 * CONVERSATION, so the method is `partner_session` and the submit may carry
 * what the partner OBSERVED of it. This builds that object.
 *
 * The API's rule, restated here because it is the whole point: a WhatsApp
 * conversation hands the partner a message and a sender, not a socket. The
 * channel's allowed keys are therefore `contact`, `message_id`, `session_id`
 * and `provider_ts`, and an `ip`, a `user_agent`, a `device_id_hash` or a
 * `geo` on this channel would have been inferred rather than observed. The
 * API refuses them (400 `attestation_evidence_invalid`), and so does this,
 * one layer earlier, because a value inferred inside a signed record reads as
 * observed and is worse than an absent one.
 *
 * WHY THE EMULATOR CANNOT PRODUCE ONE. Everything here is a claim about what a
 * provider observed. A conversation carried by an emulator on the developer's
 * own machine was observed by nobody: its message id was minted locally, its
 * timestamp came from a clock we move ourselves, and no phone was involved.
 * Signing that as evidence would be a false declaration — the same one the
 * API's own schema warns about for a partner that declares `other` for a
 * WhatsApp act. So `evidenceFor` returns a REFUSAL for any backend that is not
 * live, with the reason on it, and the caller either submits without evidence
 * or does not submit at all. That is not a gap in the seam; it is the seam
 * working.
 *
 * `live` is not a flag anyone sets: it is whether the base URL is Meta's host.
 * A run cannot claim to be live by being configured to say so.
 */
import type { InboundMessage } from "../types.js";

/** The keys the API's `whatsapp` channel accepts. Mirrored from `CONSENT_EVIDENCE_CHANNEL_KEYS`. */
export const WHATSAPP_EVIDENCE_KEYS = ["contact", "message_id", "session_id", "provider_ts"] as const;

/** Opaque provider ids: a `wamid.` carries `.`, `:`, `=` and `+`, and all four are allowed. */
const OPAQUE_ID = /^[A-Za-z0-9_.:=+-]{1,120}$/;

/**
 * The evidence as the PARTNER sends it. The wire carries `contact` in the
 * clear and the API hashes it into `contact_hash` under the org's own key —
 * a partner cannot compute that hash, and a partner-computed one would match
 * nothing.
 */
export interface WhatsAppConsentEvidence {
  channel: "whatsapp";
  contact?: string;
  message_id?: string;
  session_id?: string;
  /** Unix seconds on the PROVIDER's clock, which is not the partner's. */
  provider_ts?: number;
}

export interface ConsentAttestation {
  method: "partner_session";
  /** Unix seconds: when the PARTNER says the human authorized. */
  asserted_at: number;
  /** The partner's own record id. `^[A-Za-z0-9_-]{1,120}$` — no dots, so a `wamid` goes in `message_id`. */
  reference?: string;
  evidence: WhatsAppConsentEvidence;
}

export type EvidenceResult = { attestable: true; attestation: ConsentAttestation } | { attestable: false; reason: string };

export interface EvidenceInput {
  /** Whether the backend that carried the message talks to a real provider. */
  live: boolean;
  /** The message in which the person said yes. */
  message: InboundMessage;
  /** The partner's id for this conversation, when it has one. */
  sessionId?: string | undefined;
  /** The partner's clock, for `asserted_at`. */
  now: () => Date;
  reference?: string | undefined;
}

export function evidenceFor(input: EvidenceInput): EvidenceResult {
  if (!input.live) {
    return {
      attestable: false,
      reason:
        "this act was observed by an emulator on this machine, and a simulated observation is not evidence: " +
        "the message id was minted locally, the timestamp came from a clock we move ourselves, and no phone was involved",
    };
  }
  if (!OPAQUE_ID.test(input.message.id)) return { attestable: false, reason: `the provider message id does not fit the API's opaque-id shape: ${input.message.id.slice(0, 24)}` };
  if (!Number.isInteger(input.message.timestamp) || input.message.timestamp <= 0) return { attestable: false, reason: "the provider gave no usable timestamp for the message" };
  if (input.sessionId !== undefined && !OPAQUE_ID.test(input.sessionId)) return { attestable: false, reason: "the session id does not fit the API's opaque-id shape" };
  if (input.reference !== undefined && !/^[A-Za-z0-9_-]{1,120}$/.test(input.reference)) return { attestable: false, reason: "the attestation reference must be [A-Za-z0-9_-]{1,120}" };

  return {
    attestable: true,
    attestation: {
      method: "partner_session",
      asserted_at: Math.floor(input.now().getTime() / 1000),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      evidence: {
        channel: "whatsapp",
        contact: input.message.from,
        message_id: input.message.id,
        ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
        provider_ts: input.message.timestamp,
      },
    },
  };
}
