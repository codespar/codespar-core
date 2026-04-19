#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./api.js";
import { CliError, loadConfig, requireApiKey } from "./config.js";
import { loginCommand, whoamiCommand } from "./commands/login.js";
import { listServersCommand, showServerCommand } from "./commands/servers.js";
import { listToolsCommand, showToolCommand } from "./commands/tools.js";
import { executeCommand } from "./commands/execute.js";
import {
  closeSessionCommand,
  listSessionsCommand,
  showSessionCommand,
} from "./commands/sessions.js";
import {
  listConnectionsCommand,
  revokeConnectCommand,
  startConnectCommand,
} from "./commands/connect.js";
import { tailLogsCommand } from "./commands/logs.js";
import { initCommand } from "./commands/init.js";
import { c } from "./output.js";

const VERSION = "0.2.0";

const program = new Command();
program
  .name("codespar")
  .description("CodeSpar CLI — authenticate, inspect servers, execute tools, manage sessions.")
  .version(VERSION, "-v, --version")
  .option("--api-key <key>", "CodeSpar API key (overrides config + env)")
  .option("--base-url <url>", "API base URL (overrides config + env)")
  .option("--json", "Output machine-readable JSON instead of tables");

/** Build an authenticated ApiClient from config + CLI-level flags. */
async function authedClient(): Promise<ApiClient> {
  const config = await loadConfig();
  const root = program.opts<{ apiKey?: string; baseUrl?: string }>();
  const apiKey = root.apiKey ?? requireApiKey(config);
  const baseUrl = root.baseUrl ?? config.baseUrl ?? "https://api.codespar.dev";
  return new ApiClient({ apiKey, baseUrl });
}

function rootJsonFlag(): boolean {
  return Boolean(program.opts<{ json?: boolean }>().json);
}

// ============ auth ============
program
  .command("login")
  .description("Authenticate and save your API key to ~/.codespar/config.json")
  .option("--api-key <key>", "API key (prompts if omitted)")
  .action(async (opts: { apiKey?: string }) => {
    const root = program.opts<{ baseUrl?: string }>();
    await loginCommand({ apiKey: opts.apiKey, baseUrl: root.baseUrl });
  });

program
  .command("whoami")
  .description("Show the authenticated user, org, project, and key scopes")
  .action(async () => {
    const client = await authedClient();
    await whoamiCommand(client, rootJsonFlag());
  });

program
  .command("logout")
  .description("Clear the stored API key")
  .action(async () => {
    const { saveConfig } = await import("./config.js");
    await saveConfig({ apiKey: undefined });
    const { success } = await import("./output.js");
    success("Logged out.");
  });

// ============ servers ============
const servers = program.command("servers").description("Browse the server catalog");

servers
  .command("list")
  .description("List servers")
  .option("-c, --category <name>", "Filter by category")
  .option("-r, --region <code>", "Filter by region (e.g. BR, MX)")
  .action(async (opts: { category?: string; region?: string }) => {
    const client = await authedClient();
    await listServersCommand(client, { ...opts, json: rootJsonFlag() });
  });

servers
  .command("show <id>")
  .description("Show details of a server")
  .action(async (id: string) => {
    const client = await authedClient();
    await showServerCommand(client, id, { json: rootJsonFlag() });
  });

// ============ tools ============
const tools = program.command("tools").description("Inspect tools exposed by servers");

tools
  .command("list")
  .description("List tools")
  .option("-s, --server <id>", "Filter by server")
  .action(async (opts: { server?: string }) => {
    const client = await authedClient();
    await listToolsCommand(client, { ...opts, json: rootJsonFlag() });
  });

tools
  .command("show <name>")
  .description("Show a tool's full schema")
  .action(async (name: string) => {
    const client = await authedClient();
    await showToolCommand(client, name, { json: rootJsonFlag() });
  });

// ============ execute ============
program
  .command("execute <tool>")
  .description("Run a single tool call (creates a throwaway session)")
  .requiredOption("-s, --server <id>", "Server to open the session against")
  .option("-i, --input <json>", "Input as JSON string")
  .option("-f, --input-file <path>", "Input as JSON file path")
  .option("-u, --user <id>", "User id for the session (default: cli-user)")
  .action(async (tool: string, opts: { server: string; input?: string; inputFile?: string; user?: string }) => {
    const config = await loadConfig();
    const root = program.opts<{ apiKey?: string; baseUrl?: string }>();
    const apiKey = root.apiKey ?? requireApiKey(config);
    const baseUrl = root.baseUrl ?? config.baseUrl ?? "https://api.codespar.dev";
    await executeCommand(tool, {
      ...opts,
      apiKey,
      baseUrl,
      json: rootJsonFlag(),
    });
  });

// ============ sessions ============
const sessions = program.command("sessions").description("Inspect and manage sessions");

sessions
  .command("list")
  .description("List recent sessions")
  .option("--status <s>", "Filter by status: active, closed, error")
  .option("--limit <n>", "Max results (default 50)")
  .action(async (opts: { status?: string; limit?: string }) => {
    const client = await authedClient();
    await listSessionsCommand(client, { ...opts, json: rootJsonFlag() });
  });

sessions
  .command("show <id>")
  .description("Show a session's details")
  .option("--logs", "Also include tool-call logs")
  .action(async (id: string, opts: { logs?: boolean }) => {
    const client = await authedClient();
    await showSessionCommand(client, id, { ...opts, json: rootJsonFlag() });
  });

sessions
  .command("close <id>")
  .description("Close an active session")
  .action(async (id: string) => {
    const client = await authedClient();
    await closeSessionCommand(client, id);
  });

// ============ connect ============
const connect = program.command("connect").description("Manage Connect Links for end-user provider OAuth");

connect
  .command("list")
  .description("List active connections")
  .option("-u, --user <id>", "Filter by user")
  .option("--status <s>", "Filter by status: connected, pending, revoked, expired")
  .action(async (opts: { user?: string; status?: string }) => {
    const client = await authedClient();
    await listConnectionsCommand(client, { ...opts, json: rootJsonFlag() });
  });

connect
  .command("start <server>")
  .description("Start a Connect Link flow for a server")
  .option("-u, --user <id>", "User id (default: cli-user)")
  .option("--open", "Open the link in the system browser")
  .action(async (server: string, opts: { user?: string; open?: boolean }) => {
    const client = await authedClient();
    await startConnectCommand(client, server, { ...opts, json: rootJsonFlag() });
  });

connect
  .command("revoke <server>")
  .description("Revoke an existing connection")
  .option("-u, --user <id>", "User id (default: cli-user)")
  .action(async (server: string, opts: { user?: string }) => {
    const client = await authedClient();
    await revokeConnectCommand(client, server, opts);
  });

// ============ logs ============
const logs = program.command("logs").description("Inspect tool-call execution logs");

logs
  .command("tail")
  .description("Stream logs in real time (SSE)")
  .option("-s, --server <id>", "Filter by server")
  .option("--status <s>", "Filter by status: success, error, running")
  .option("-t, --tool <name>", "Filter by tool name")
  .option("--limit <n>", "Request up to N backfilled entries before tailing")
  .action(async (opts: { server?: string; status?: string; tool?: string; limit?: string }) => {
    const config = await loadConfig();
    const root = program.opts<{ apiKey?: string; baseUrl?: string }>();
    const apiKey = root.apiKey ?? requireApiKey(config);
    const baseUrl = root.baseUrl ?? config.baseUrl ?? "https://api.codespar.dev";
    await tailLogsCommand({ apiKey, baseUrl }, { ...opts, json: rootJsonFlag() });
  });

// ============ init ============
program
  .command("init <name>")
  .description("Scaffold a new commerce agent from a template")
  .option("-t, --template <slug>", "Template slug (pix-agent, ecommerce-checkout, streaming-chat, multi-tenant)")
  .option("-y, --yes", "Use default template without prompting")
  .action(async (name: string, opts: { template?: string; yes?: boolean }) => {
    await initCommand(name, opts);
  });

// ============ global error handling ============
async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${c.red("✗")} ${err.message}\n`);
      process.exit(1);
    }
    // Unexpected error — show stack so we can debug.
    process.stderr.write(`${c.red("✗ internal error:")}\n`);
    process.stderr.write(String((err as Error).stack ?? err) + "\n");
    process.exit(2);
  }
}

main();
