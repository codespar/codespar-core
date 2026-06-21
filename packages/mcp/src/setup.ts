/**
 * First-run / bad-key onboarding surface for the stdio MCP server.
 *
 * When the server boots without a key (or with a rejected one), it must not
 * crash — that leaves the MCP client showing only "server failed to start" and
 * the agent with nothing to act on. Instead it starts and exposes one tool whose
 * description + result hand the agent the steps to get a free key and relay them
 * to the user. That turns the single biggest activation leak (install -> never
 * sets a key) into a guided onboarding.
 *
 * These helpers are side-effect-free and kept out of bin.ts (whose top-level
 * main() starts a server on import) so they stay unit-testable.
 */
export const SETUP_TOOL = "codespar_get_started";

export const SETUP_TOOL_DESCRIPTION =
  "Activate CodeSpar to unlock LATAM commerce tools (Pix, boleto, NF-e, cards, " +
  "shipping, KYC). CodeSpar needs a free API key — call this tool for the exact " +
  "setup steps to give the user.";

export const KEY_URL = "https://codespar.dev/dashboard/settings?tab=api-keys";

/** A bad/wrong/revoked key surfaces as a 401 (or 403) CodesparApiError. */
export function isAuthError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return status === 401 || status === 403;
}

export function setupMessage(reason: "no-key" | "bad-key"): string {
  const lead =
    reason === "bad-key"
      ? "Your CODESPAR_API_KEY was rejected (it may be wrong, revoked, or for the wrong environment)."
      : "CodeSpar isn't activated yet — it needs a free API key.";
  return [
    lead,
    "",
    "Setup takes about 2 minutes:",
    `  1. Create a free key: ${KEY_URL}`,
    "  2. Put it in this MCP server's env as CODESPAR_API_KEY=csk_...",
    '     (the "env" block of the "codespar" server in your MCP client config —',
    "      Claude Desktop, Claude Code, Cursor, Codex, or VS Code).",
    "  3. Restart the MCP server.",
    "",
    "Then this server exposes the full LATAM commerce toolset (Pix, boleto, NF-e,",
    "cards, shipping, KYC, and more). Please relay these steps to the user so they",
    "can paste the key.",
  ].join("\n");
}
