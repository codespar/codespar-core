import { CliError } from "../config.js";
import { c, info, json, kv, success, warn } from "../output.js";
import {
  agentDidFromKid,
  decodeToken,
  parsePubkeyHex,
  reconstructSigningString,
  verifyEd25519,
  type DecodedToken,
} from "../mandate-codec.js";
import {
  DidConfigError,
  didWebParts,
  parseBaseUrl,
  parseIdentityHost,
  resolveDidKeys,
  type DidKey,
  type DidResolution,
  type DidSource,
} from "../did.js";

export interface MandateVerifyOptions {
  /** Raw 32-byte Ed25519 agent public key (hex). Presence forces offline mode. */
  agentPubkey?: string;
  /** Raw 32-byte Ed25519 issuer public key (hex). Presence forces offline mode. */
  issuerPubkey?: string;
  /** Override the issuer DID (default: did:web derived from the agent DID host). */
  issuerDid?: string;
  /**
   * Explicit resolver base URL for network mode: consulted for any DID whose
   * did:web document is unreachable. Opt-in; announced on stderr when used.
   */
  resolver?: string;
  /** Identity hosts the API's DID route may serve, beyond the built-in ones (`--did-domain`). */
  didDomains?: string[];
  baseUrl: string;
  json?: boolean;
}

type SigStatus = "verified" | "failed" | "skipped";

interface SigResult {
  present: boolean;
  status: SigStatus;
  /** The verificationMethod / key id that verified the signature (or was tried). */
  kid?: string;
  /** Where the public key came from; null when nothing supplied one. */
  source: DidSource | "flag" | null;
  detail?: string;
  /** Network mode: no key could be resolved to check it against. */
  unresolved?: boolean;
}

/** did:web platform issuer DID: the agent DID's validated host segment, alone. */
function platformIssuerDid(agentDid: string): string | null {
  const parts = didWebParts(agentDid);
  return parts ? `did:web:${parts.hostSegment}` : null;
}

/**
 * Say on stderr when a key did not come from the DID's own domain. A resolver
 * is a third party the user opted into; the API route is the deployment's own
 * service answering for its own domain. Either way the user should see that
 * the domain itself did not answer.
 */
function announceSource(did: string, resolved: DidResolution): void {
  if (resolved.source === "resolver") {
    warn(
      `${did}: keys came from the resolver at ${resolved.tried[resolved.tried.length - 1]}, ` +
        `not from the domain's did:web document`,
    );
  } else if (resolved.source === "fallback") {
    info(`${did}: did:web document unreachable; keys came from the API's DID route`);
  }
}

/** Turn a configuration error from the DID layer into a CliError naming the flag. */
function cliConfig<T>(flag: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DidConfigError) throw new CliError(`${flag}: ${err.message}.`);
    throw err;
  }
}

/** Try a signature against a set of candidate keys; first hit wins. */
function verifyAgainst(
  signingString: string,
  sig: string,
  keys: DidKey[],
): DidKey | null {
  for (const k of keys) {
    if (verifyEd25519(signingString, sig, k.pubkey)) return k;
  }
  return null;
}

/**
 * Why a token is not verified. The codes of `@codespar/sdk/mandate` and the
 * Python `codespar.mandate`, in the same order, plus `*_key_unresolved` for a
 * network-mode key that no source supplied.
 */
type Failure =
  | "kid_mismatch"
  | "kid_not_in_document"
  | "agent_sig_absent"
  | "agent_sig_unchecked"
  | "agent_sig_invalid"
  | "agent_key_unresolved"
  | "issuer_sig_absent"
  | "issuer_sig_unchecked"
  | "issuer_sig_invalid"
  | "issuer_key_unresolved"
  | "expired";

function failureFor(who: "agent" | "issuer", r: SigResult): Failure | null {
  if (!r.present) return `${who}_sig_absent`;
  if (r.status === "verified") return null;
  if (r.unresolved) return `${who}_key_unresolved`;
  return r.status === "skipped" ? `${who}_sig_unchecked` : `${who}_sig_invalid`;
}

/**
 * Verify a V3 or V4 mandate presentation token.
 *
 *   codespar mandate verify <token>
 *
 * Offline mode (any --agent-pubkey / --issuer-pubkey given): verify the named
 * signatures against the supplied raw Ed25519 keys with zero network calls.
 * Network mode (no pubkey flags): resolve the agent + issuer public keys from
 * their did:web documents and verify. The domain named in the DID is the
 * authority; the configured API's DID route is consulted only for a DID under
 * one of the deployment's identity hosts whose document is unreachable, and
 * `--resolver <url>` opts into a resolver for any DID, announced on stderr
 * when it is the source. The two DIDs resolve in parallel.
 *
 * "Verified" means all of it was checked: both signatures are carried and
 * verify, the agent signature under the key the token names (its signed
 * `agent_kid`; the document's other keys, retired ones included, are not
 * tried), and the clock is not past `expires_at`. A signature the token does
 * not carry, or one no key was supplied for, is not a pass. Exit code is
 * non-zero whenever the token is not verified.
 */
export async function mandateVerifyCommand(
  token: string,
  opts: MandateVerifyOptions,
): Promise<void> {
  const decoded = decodeToken(token);
  if (!decoded.ok) {
    if (opts.json) {
      json({ verified: false, error: decoded.error });
      process.exitCode = 1;
      return;
    }
    throw new CliError(
      decoded.error === "mandate_format_unsupported"
        ? "unsupported mandate format (need format_version >= 2)."
        : "cannot decode token — not a valid base64url mandate presentation token.",
    );
  }

  const t: DecodedToken = decoded.token;
  const m = t.mandate;
  const signingString = reconstructSigningString(m as unknown as Record<string, unknown>);
  const offline = Boolean(opts.agentPubkey || opts.issuerPubkey);

  // The signed agent_kid names the key; the envelope kid is an unsigned copy
  // and may not rename it. V2 signs no kid, so there the envelope is all there is.
  const signedKid = typeof m.agent_kid === "string" ? m.agent_kid : undefined;
  const agentKid = signedKid ?? t.kid;
  const kidMismatch = signedKid !== undefined && t.kid !== undefined && t.kid !== signedKid;
  const agentDid = agentKid ? agentDidFromKid(agentKid) : undefined;
  const issuerDid = opts.issuerDid ?? (agentDid ? platformIssuerDid(agentDid) : null);
  // Validate every URL and host before any request, so a typo is a CliError
  // and never a rejection inside the parallel resolution below.
  const resolverUrl =
    opts.resolver === undefined
      ? undefined
      : cliConfig("--resolver", () => parseBaseUrl(opts.resolver!, "--resolver").toString());
  const didDomains = (opts.didDomains ?? []).map((h) =>
    cliConfig("--did-domain", () => parseIdentityHost(h)),
  );
  if (!offline) cliConfig("--base-url", () => parseBaseUrl(opts.baseUrl, "--base-url"));

  // Network mode resolves both DIDs at once: sequentially, two unreachable
  // documents with a resolver and a fallback each are four timeouts in a row.
  const resolveOpts = { baseUrl: opts.baseUrl, resolverUrl, didDomains };
  const [agentResolved, issuerResolved] = offline
    ? [null, null]
    : await Promise.all([
        t.agent_sig && agentDid && !kidMismatch ? resolveDidKeys(agentDid, resolveOpts) : null,
        t.issuer_sig && issuerDid ? resolveDidKeys(issuerDid, resolveOpts) : null,
      ]);

  // ── Agent signature ──────────────────────────────────────────────
  const agent: SigResult = { present: Boolean(t.agent_sig), status: "skipped", source: null };
  let kidNotInDocument = false;
  if (t.agent_sig && kidMismatch) {
    agent.status = "failed";
    agent.kid = agentKid;
    agent.detail = `the envelope kid ${t.kid} is not the signed agent_kid`;
  } else if (t.agent_sig) {
    if (offline) {
      if (opts.agentPubkey) {
        const pub = parsePubkeyHex(opts.agentPubkey);
        if (!pub) throw new CliError("--agent-pubkey must be 64 hex chars (a raw 32-byte Ed25519 key).");
        agent.source = "flag";
        const hit = verifyAgainst(signingString, t.agent_sig, [{ kid: agentKid ?? "(flag)", pubkey: pub }]);
        agent.status = hit ? "verified" : "failed";
        agent.kid = agentKid;
      } else {
        agent.status = "skipped";
        agent.detail = "no --agent-pubkey supplied";
      }
    } else {
      if (!agentDid || !agentResolved) {
        agent.status = "failed";
        agent.unresolved = true;
        agent.source = null;
        agent.detail = "token carries no agent_kid to resolve";
      } else {
        const resolved = agentResolved;
        agent.source = resolved.source;
        if (resolved.keys.length === 0) {
          agent.status = "failed";
          agent.unresolved = true;
          agent.detail = `could not resolve ${agentDid}: ${resolved.detail}`;
        } else {
          announceSource(agentDid, resolved);
          agent.kid = agentKid;
          // Only the key the token names. The document lists retired keys on
          // purpose (their past signatures stay checkable), so trying every
          // key let a retired one verify a token naming the active one.
          const named = resolved.keys.filter((k) => k.kid === agentKid);
          if (named.length === 0) {
            agent.status = "failed";
            kidNotInDocument = true;
            agent.detail = `${agentDid}'s document has no Ed25519 key ${agentKid}`;
          } else {
            agent.status = verifyAgainst(signingString, t.agent_sig, named) ? "verified" : "failed";
          }
        }
      }
    }
  }

  // ── Issuer signature ─────────────────────────────────────────────
  const issuer: SigResult = { present: Boolean(t.issuer_sig), status: "skipped", source: null };
  if (t.issuer_sig) {
    if (offline) {
      if (opts.issuerPubkey) {
        const pub = parsePubkeyHex(opts.issuerPubkey);
        if (!pub) throw new CliError("--issuer-pubkey must be 64 hex chars (a raw 32-byte Ed25519 key).");
        issuer.source = "flag";
        const hit = verifyAgainst(signingString, t.issuer_sig, [{ kid: "(flag)", pubkey: pub }]);
        issuer.status = hit ? "verified" : "failed";
      } else {
        issuer.status = "skipped";
        issuer.detail = "no --issuer-pubkey supplied";
      }
    } else {
      if (!issuerDid || !issuerResolved) {
        issuer.status = "failed";
        issuer.unresolved = true;
        issuer.source = null;
        issuer.detail = "no issuer DID (pass --issuer-did)";
      } else {
        // The token names no issuer key (the envelope kid is the agent's), so
        // every Ed25519 key the issuer document publishes is tried.
        const resolved = issuerResolved;
        issuer.source = resolved.source;
        if (resolved.keys.length === 0) {
          issuer.status = "failed";
          issuer.unresolved = true;
          issuer.detail = `could not resolve ${issuerDid}: ${resolved.detail}`;
        } else {
          announceSource(issuerDid, resolved);
          const hit = verifyAgainst(signingString, t.issuer_sig, resolved.keys);
          issuer.status = hit ? "verified" : "failed";
          issuer.kid = hit?.kid;
        }
      }
    }
  }

  const expiresIso = Number.isFinite(m.expires_at)
    ? new Date(m.expires_at * 1000).toISOString()
    : null;
  // The API refuses a mandate only once the clock is past expires_at.
  const expired = Number.isFinite(m.expires_at) ? m.expires_at * 1000 < Date.now() : false;
  const issuedAt = typeof m.issued_at === "number" ? m.issued_at : null;
  const issuedIso = issuedAt !== null ? new Date(issuedAt * 1000).toISOString() : null;

  const failures: Failure[] = [];
  if (kidMismatch && t.agent_sig) failures.push("kid_mismatch");
  else if (kidNotInDocument) failures.push("kid_not_in_document");
  else {
    const f = failureFor("agent", agent);
    if (f) failures.push(f);
  }
  const issuerFailure = failureFor("issuer", issuer);
  if (issuerFailure) failures.push(issuerFailure);
  if (expired) failures.push("expired");
  const verified = failures.length === 0;

  if (opts.json) {
    json({
      verified,
      failures,
      mode: offline ? "offline" : "network",
      format_version: m.format_version,
      signatures: {
        agent_sig: sigJson(agent),
        issuer_sig: sigJson(issuer),
      },
      mandate: {
        id: m.id,
        agent_id: m.agent_id,
        agent_did: agentDid ?? null,
        kid: agentKid ?? null,
        type: m.type,
        amount: m.amount,
        currency: m.currency,
        max_amount: m.max_amount ?? null,
        parent_id: m.parent_id ?? null,
        denomination: m.denomination ?? null,
        purposes: m.purposes,
        // Redacted: never emit the CPF/CNPJ reference itself, only its presence.
        principal_kyc_ref_present: Boolean(m.principal_kyc_ref),
        expires_at: m.expires_at,
        expires_at_iso: expiresIso,
        expired,
        issued_at: issuedAt,
        issued_at_iso: issuedIso,
        format_version: m.format_version,
      },
    });
    if (!verified) process.exitCode = 1;
    return;
  }

  // ── Human output ─────────────────────────────────────────────────
  if (verified) success(`mandate token verified (${offline ? "offline" : "network"} mode)`);
  else warn(`mandate token NOT verified (${offline ? "offline" : "network"} mode)`);

  process.stdout.write(c.bold("\nsignatures\n"));
  kv([
    ["agent_sig", sigLine(agent)],
    ["issuer_sig", sigLine(issuer)],
  ]);

  process.stdout.write(c.bold("\nmandate\n"));
  kv([
    ["id", m.id],
    ["agent_id", m.agent_id],
    ["agent_did", agentDid ?? "(none)"],
    ["kid", agentKid ?? "(none)"],
    ["type", m.type],
    ["amount", `${m.amount} ${m.currency}`],
    ["max_amount", m.max_amount ? `${m.max_amount} ${m.currency}` : "(none)"],
    ["purposes", m.purposes.join(", ")],
    ["principal_kyc", m.principal_kyc_ref ? "present" : "absent"],
    [
      "expires_at",
      expiresIso ? `${m.expires_at} (${expiresIso})${expired ? c.yellow("  [expired]") : ""}` : String(m.expires_at),
    ],
    ...(issuedIso ? ([["issued_at", `${issuedAt} (${issuedIso})`]] as [string, string][]) : []),
    ["format", `v${m.format_version}`],
  ]);

  if (!verified) {
    info(`Not verified: ${failures.map(describeFailure).join("; ")}.`);
    process.exitCode = 1;
  }
}

function describeFailure(f: Failure): string {
  switch (f) {
    case "kid_mismatch":
      return "the envelope kid differs from the signed agent_kid";
    case "kid_not_in_document":
      return "the agent's DID document has no key under the kid the token names";
    case "agent_sig_absent":
      return "the token carries no agent signature";
    case "issuer_sig_absent":
      return "the token carries no issuer signature";
    case "agent_sig_unchecked":
      return "the agent signature was not checked (no --agent-pubkey)";
    case "issuer_sig_unchecked":
      return "the issuer signature was not checked (no --issuer-pubkey)";
    case "agent_sig_invalid":
      return "the agent signature did not verify";
    case "issuer_sig_invalid":
      return "the issuer signature did not verify";
    case "agent_key_unresolved":
      return "no source supplied the agent's key";
    case "issuer_key_unresolved":
      return "no source supplied the issuer's key";
    case "expired":
      return "the mandate is past expires_at";
  }
}

function statusMark(status: SigStatus): string {
  if (status === "verified") return c.green("✓ verified");
  if (status === "failed") return c.red("✗ failed");
  return c.gray("– skipped");
}

function sigLine(r: SigResult): string {
  if (!r.present) return c.gray("– absent (not in token)");
  const bits = [statusMark(r.status)];
  if (r.kid) bits.push(c.gray(`kid ${r.kid}`));
  if (r.source) bits.push(c.gray(`via ${r.source}`));
  if (r.detail) bits.push(c.gray(`(${r.detail})`));
  return bits.join("  ");
}

function sigJson(r: SigResult): Record<string, unknown> {
  return {
    present: r.present,
    status: r.present ? r.status : "absent",
    kid: r.kid ?? null,
    source: r.source,
    detail: r.detail ?? null,
  };
}
