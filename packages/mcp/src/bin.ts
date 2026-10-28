#!/usr/bin/env node
/**
 * @codespar/mcp — stdio MCP server
 *
 * Bridges any MCP client (Claude Desktop, Claude Code, Cursor, Codex,
 * VS Code) to a CodeSpar session's commerce tools. It does NOT depend on
 * a backend MCP transport: `tools/list` and `tools/call` are served by
 * calling the existing REST surface (`POST /v1/sessions/:id/execute`) via
 * `@codespar/sdk`. So "Install in Codex / Claude" works against the live
 * meta-tools (codespar_pay, codespar_charge, codespar_discover, wallet,
 * mandates, ...) today.
 *
 * Config (env or flags):
 *   CODESPAR_API_KEY   csk_ / csk_live_ key. Missing or rejected → the server
 *                      still starts (setup mode) and hands the agent the steps
 *                      to get a free key, instead of crashing at boot.
 *   CODESPAR_PROJECT   --project   prj_… to scope to one project
 *   CODESPAR_PRESET    --preset    brazilian|mexican|argentinian|colombian|all (default: brazilian)
 *   CODESPAR_SERVERS   --servers   comma list (overrides preset's server set)
 *   CODESPAR_USER_ID   --user      stable user id for the session (default: "mcp-user")
 *
 * stdout is the MCP transport — all logging goes to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callShopPurchaseTool, isShopPurchaseTool } from "./shop-purchase-tools.js";
import { callPayablesTool, isPayablesTool, payablesErrorText } from "./payables-tools.js";
import { callDocumentsTool, documentsErrorText, isDocumentsTool, type DocumentsFacades } from "./documents-tools.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CodeSpar, tools as listTools } from "@codespar/sdk";
import type { Payables, Session, Tool, ToolResult } from "@codespar/sdk";
import {
  SETUP_TOOL,
  SETUP_TOOL_DESCRIPTION,
  setupMessage,
} from "./setup.js";
import { NO_SESSION_MESSAGE, bootSession, listedTools, type Boot } from "./boot.js";
import { MCP_VERSION } from "./version.js";

type Preset = "brazilian" | "mexican" | "argentinian" | "colombian" | "all";

// The published version, from package.json (version.ts): never a literal here.
const VERSION = MCP_VERSION;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(msg: string): void {
  process.stderr.write(`[codespar-mcp] ${msg}\n`);
}

/**
 * First-run / bad-key path. Instead of exiting (which leaves the MCP client
 * showing only "server failed to start" and the agent with nothing to act on),
 * boot a working server that exposes a single onboarding tool. The agent reads
 * its description on `tools/list` and gets the exact setup steps to relay to the
 * user — turning a dead end into activation.
 */
async function runSetupServer(reason: "no-key" | "bad-key"): Promise<void> {
  const message = setupMessage(reason);
  const server = new Server(
    { name: "codespar", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: SETUP_TOOL,
        description: SETUP_TOOL_DESCRIPTION,
        inputSchema: { type: "object" },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: message }],
    isError: false,
  }));
  await server.connect(new StdioServerTransport());
  log(`setup mode (${reason}) — exposing ${SETUP_TOOL}; set CODESPAR_API_KEY to activate`);
}

async function main(): Promise<void> {
  // Canonical invocation is `codespar-mcp serve` (what every install snippet on
  // /agents shows). Accept it explicitly — and a bare invocation, for
  // back-compat — and reject an unknown command instead of silently ignoring an
  // unmatched positional the way earlier builds did.
  const command =
    process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "serve";
  if (command !== "serve") {
    log(
      `unknown command "${command}". Usage: codespar-mcp serve ` +
        `[--project <prj_…>] [--preset brazilian|mexican|argentinian|colombian|all] ` +
        `[--servers a,b,c] [--user <id>]`,
    );
    process.exit(1);
  }

  const apiKey = process.env.CODESPAR_API_KEY;
  if (!apiKey) {
    log("no CODESPAR_API_KEY — starting in setup mode. Free key: https://codespar.dev/dashboard/settings?tab=api-keys");
    return runSetupServer("no-key");
  }

  const projectId = flag("project") ?? process.env.CODESPAR_PROJECT ?? undefined;
  const preset = (flag("preset") ?? process.env.CODESPAR_PRESET ?? "brazilian") as Preset;
  const serversRaw = flag("servers") ?? process.env.CODESPAR_SERVERS;
  const servers = serversRaw ? serversRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const userId = flag("user") ?? process.env.CODESPAR_USER_ID ?? "mcp-user";

  const cs = new CodeSpar({ apiKey, projectId });
  // `servers` (when given) wins over `preset`; otherwise the preset selects
  // the buyer/commerce server set. This is what makes the session "Curb":
  // a buy-side preset surfaces search / cart / checkout / wallet / mandate.
  //
  // A 401 is a key that is not usable: setup guidance instead of a crash. A
  // 403 is a valid key without `sessions:create` (boot.ts): the server runs
  // with the tools that need no session. Real outages (network, 5xx) still
  // fail loudly.
  const boot: Boot = await bootSession(
    () => cs.create(userId, servers ? { servers, projectId } : { preset, projectId }),
    (s: Session) => listTools(s),
  );
  if (boot.kind === "setup") {
    log("API key rejected (401) — starting in setup mode");
    return runSetupServer("bad-key");
  }
  const session: Session | null = boot.kind === "session" ? boot.session : null;
  // `cs.payables` arrived in @codespar/sdk 0.16.19; the peer range is wider,
  // so an older SDK simply does not get the tool.
  const payables = (cs as { payables?: Payables }).payables;
  // `cs.receipts` / `cs.account` arrived in @codespar/sdk 0.16.22: the documents
  // tool exists only when both are there. REST routes, no session needed.
  const facades = cs as Partial<DocumentsFacades>;
  const documents: DocumentsFacades | null = facades.receipts && facades.account ? { receipts: facades.receipts, account: facades.account } : null;
  const listed = listedTools(boot, { payables: Boolean(payables), documents: documents !== null });
  if (session) log(`session ${session.id} (preset=${servers ? "custom" : preset}) ready`);
  else log("no session: the key lacks `sessions:create` (403); hosted tools are not offered, codespar_payables is");
  log(`exposing ${listed.length} tool(s): ${listed.map((t) => t.name).join(", ") || "(none — check connections)"}`);

  const server = new Server(
    { name: "codespar", version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Hosted tools (relayed as published), Shop v0.2 purchases (propose and read
  // only) and payables (local upload): what each needs is decided in boot.ts.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (isShopPurchaseTool(name)) {
      if (!session) return { content: [{ type: "text", text: NO_SESSION_MESSAGE }], isError: true };
      try {
        const out = await callShopPurchaseTool(session, name, args);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }
    if (documents && isDocumentsTool(name)) {
      try {
        const out = await callDocumentsTool(documents, args);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false };
      } catch (err) {
        return { content: [{ type: "text", text: documentsErrorText(err) }], isError: true };
      }
    }
    if (payables && isPayablesTool(name)) {
      try {
        const out = await callPayablesTool(payables, args, { allowLocalFiles: true });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false };
      } catch (err) {
        return { content: [{ type: "text", text: payablesErrorText(err) }], isError: true };
      }
    }
    if (!session) {
      return {
        content: [{ type: "text", text: NO_SESSION_MESSAGE }],
        isError: true,
      };
    }
    const result: ToolResult = await session.execute(name, args);
    const payload = result.success ? (result.data ?? result) : result.error;
    return {
      content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
      isError: !result.success,
    };
  });

  await server.connect(new StdioServerTransport());
  log("connected over stdio");
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
