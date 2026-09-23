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
 * Verify a V3 mandate presentation token.
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
 * A signature the token carries must verify for an overall pass. In offline mode
 * a signature with no supplied key is "skipped" (not proven, not failed); at
 * least one signature must verify and none may fail. In network mode an
 * unresolvable key is a failure. Exit code is non-zero on any failure.
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

  const agentKid = t.kid ?? m.agent_kid ?? undefined;
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
        t.agent_sig && agentDid
          ? resolveDidKeys(agentDid, { ...resolveOpts, preferredKid: agentKid })
          : null,
        t.issuer_sig && issuerDid ? resolveDidKeys(issuerDid, resolveOpts) : null,
      ]);

  // ── Agent signature ──────────────────────────────────────────────
  const agent: SigResult = { present: Boolean(t.agent_sig), status: "skipped", source: null };
  if (t.agent_sig) {
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
        agent.source = null;
        agent.detail = "token carries no agent_kid to resolve";
      } else {
        const resolved = agentResolved;
        agent.source = resolved.source;
        if (resolved.keys.length === 0) {
          agent.status = "failed";
          agent.detail = `could not resolve ${agentDid}: ${resolved.detail}`;
        } else {
          announceSource(agentDid, resolved);
          const hit = verifyAgainst(signingString, t.agent_sig, resolved.keys);
          agent.status = hit ? "verified" : "failed";
          agent.kid = hit?.kid ?? agentKid;
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
        issuer.source = null;
        issuer.detail = "no issuer DID (pass --issuer-did)";
      } else {
        // The envelope names the agent kid, not the issuer's, so try every
        // Ed25519 key the issuer document publishes.
        const resolved = issuerResolved;
        issuer.source = resolved.source;
        if (resolved.keys.length === 0) {
          issuer.status = "failed";
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

  const anyVerified = agent.status === "verified" || issuer.status === "verified";
  const anyFailed = agent.status === "failed" || issuer.status === "failed";
  const verified = anyVerified && !anyFailed;

  const expiresIso = Number.isFinite(m.expires_at)
    ? new Date(m.expires_at * 1000).toISOString()
    : null;
  const expired = Number.isFinite(m.expires_at) ? m.expires_at * 1000 < Date.now() : false;

  if (opts.json) {
    json({
      verified,
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
    ["format", `v${m.format_version}`],
  ]);

  if (!verified) {
    info("A NOT-verified result means a carried signature failed or could not be checked. See the per-signature status above.");
    process.exitCode = 1;
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
