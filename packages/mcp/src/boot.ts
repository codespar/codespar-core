/**
 * How the stdio server boots against a key's scopes.
 *
 * Measured on 26/10/2026 (QA account): the server created a session at boot
 * and read a 403 as a rejected key, so a key holding only `payables:read` /
 * `payables:write` fell into setup mode and never exposed `codespar_payables`,
 * although paying documents needs no session at all. The API answers 401 for
 * an unknown, revoked or expired key (one uniform payload, auth.ts) and 403
 * for a valid key that lacks the route's scope (`sessions:create` here), so the
 * two are told apart by status:
 *
 *   401            setup mode (the key is not usable)
 *   403            no session: the key is valid and lacks `sessions:create`;
 *                  the server runs with the tools that need no session
 *   anything else  an outage, surfaced as before
 *
 * Without a session the hosted tools (`codespar_wallet`, `codespar_pay`, …)
 * and the Shop purchase tools are not offered: they execute through the
 * session, so a key without `sessions:create` cannot reach them, whatever its
 * other scopes. `codespar_payables` runs over the REST routes and is offered.
 * Pure functions, kept out of bin.ts so they are unit-testable.
 */
import type { Session, Tool } from "@codespar/sdk";
import { PAYABLES_TOOL_NAME, payablesToolDefinition } from "./payables-tools.js";
import { documentsToolDefinition } from "./documents-tools.js";
import { SHOP_PURCHASE_MCP_TOOLS } from "./shop-purchase-tools.js";

export type Boot =
  | { kind: "session"; session: Session; tools: Tool[] }
  /** A valid key without `sessions:create`: no session, no hosted tools. */
  | { kind: "no_session"; status: 403 }
  /** The key is not usable (401): setup mode. */
  | { kind: "setup" };

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

export async function bootSession(
  create: () => Promise<Session>,
  list: (session: Session) => Promise<Tool[]>,
): Promise<Boot> {
  let session: Session;
  try {
    session = await create();
  } catch (err) {
    const status = statusOf(err);
    if (status === 401) return { kind: "setup" };
    if (status === 403) return { kind: "no_session", status: 403 };
    throw err;
  }
  return { kind: "session", session, tools: await list(session) };
}

export interface McpListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The `tools/list` answer for a boot: hosted tools and Shop purchases only with a session; payables and documents whenever the SDK has them (they run over REST, no session). */
export function listedTools(boot: Boot, opts: { payables: boolean; documents?: boolean }): McpListedTool[] {
  const hosted: McpListedTool[] =
    boot.kind === "session"
      ? boot.tools
          // This server's codespar_payables (with local upload) replaces a hosted
          // tool of the same name: an MCP client must not see two.
          .filter((t) => !(opts.payables && t.name === PAYABLES_TOOL_NAME))
          .map((t) => ({
            name: t.name,
            description: t.description,
            // CodeSpar tools carry a JSON Schema already; default to an open object
            // so clients that require a schema still accept the tool.
            inputSchema:
              t.input_schema && Object.keys(t.input_schema).length > 0 ? t.input_schema : { type: "object" },
          }))
      : [];
  const shop = boot.kind === "session" && boot.session.purchases ? SHOP_PURCHASE_MCP_TOOLS : [];
  return [...hosted, ...shop, ...(opts.payables ? [payablesToolDefinition(true)] : []), ...(opts.documents ? [documentsToolDefinition()] : [])];
}

/** What a client is told when it calls a session tool and the key has no session. */
export const NO_SESSION_MESSAGE =
  "This CODESPAR_API_KEY has no `sessions:create` scope, so the hosted tools (codespar_wallet, codespar_pay, " +
  "codespar_shop, …) are not available on this server: they run inside a session. codespar_payables works " +
  "with payables:read / payables:write. To use the others, mint a key with `sessions:create` (and the " +
  "scopes of the actions you need, e.g. consumers:pix-keys for the Pix key actions) and restart the server.";
