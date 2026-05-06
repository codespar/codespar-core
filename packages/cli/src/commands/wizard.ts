import { CodeSpar } from "@codespar/sdk";
import type { ConnectionWizardOptions, ConnectionWizardResult } from "@codespar/sdk";
import { CliError } from "../config.js";
import { c, info, json, kv, success, table } from "../output.js";

interface WizardCommandOptions {
  apiKey: string;
  baseUrl: string;
  user?: string;
  action?: string;
  country?: string;
  environment?: string;
  returnTo?: string;
  json?: boolean;
}

/**
 * Wraps `session.connectionWizard(options)`. The SDK expects a
 * `ConnectionWizardOptions` (action defaults to "list" without a
 * server_id, "status" with one). The CLI takes the server-id as the
 * positional argument; pass nothing to list all connections.
 */
export async function wizardCommand(
  serverId: string | undefined,
  opts: WizardCommandOptions,
): Promise<void> {
  if (opts.action && !["list", "status", "initiate"].includes(opts.action)) {
    throw new CliError("--action must be one of: list, status, initiate.");
  }
  if (opts.environment && !["live", "test"].includes(opts.environment)) {
    throw new CliError("--environment must be 'live' or 'test'.");
  }

  const wizardOpts: ConnectionWizardOptions = {};
  if (serverId) wizardOpts.server_id = serverId;
  if (opts.action) wizardOpts.action = opts.action as ConnectionWizardOptions["action"];
  if (opts.country) wizardOpts.country = opts.country;
  if (opts.environment) wizardOpts.environment = opts.environment as "live" | "test";
  if (opts.returnTo) wizardOpts.return_to = opts.returnTo;

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const session = await cs.create(userId, { servers: [] });

  try {
    const result: ConnectionWizardResult = await session.connectionWizard(wizardOpts);

    if (opts.json) {
      json(result);
      return;
    }

    renderWizardResult(result);
  } finally {
    await session.close();
  }
}

function renderWizardResult(result: ConnectionWizardResult): void {
  if (result.action === "list") {
    if (result.connections.length === 0) {
      process.stderr.write(c.dim("(no connections)\n"));
      return;
    }
    table(
      ["SERVER", "AUTH", "STATUS", "DIFFICULTY", "CONNECTED"],
      result.connections.map((row) => [
        row.server_id,
        row.auth_type,
        row.status,
        row.difficulty,
        row.connected_at ? new Date(row.connected_at).toISOString().slice(0, 10) : "-",
      ]),
    );
    return;
  }

  if (result.action === "status") {
    if (!result.status) {
      process.stderr.write(c.dim("(no status returned)\n"));
      return;
    }
    const s = result.status;
    success(`${s.server_id} → ${s.status}`);
    kv([
      ["display_name", s.display_name],
      ["auth_type", s.auth_type],
      ["difficulty", s.difficulty],
      ["connected_at", s.connected_at ?? "-"],
    ]);
    return;
  }

  if (result.action === "initiate") {
    if (!result.initiate) {
      process.stderr.write(c.dim("(no instructions returned)\n"));
      return;
    }
    const i = result.initiate;
    success(`${i.display_name} (${i.auth_type}) → ${i.status}`);
    kv([
      ["server_id", i.server_id],
      ["difficulty", i.difficulty],
      ["connect_url", i.connect_url],
      ["next_action", i.next_action],
    ]);
    if (i.required_secrets.length > 0) {
      process.stdout.write("\n");
      info("Required secrets:");
      for (const s of i.required_secrets) {
        process.stdout.write(`  - ${s.name}${s.hint ? `  ${c.dim(`(${s.hint})`)}` : ""}\n`);
      }
    }
    if (i.instructions.length > 0) {
      process.stdout.write("\n");
      info("Instructions:");
      i.instructions.forEach((line, idx) =>
        process.stdout.write(`  ${idx + 1}. ${line}\n`),
      );
    }
    if (i.known_pitfalls.length > 0) {
      process.stdout.write("\n");
      info("Known pitfalls:");
      for (const p of i.known_pitfalls) {
        process.stdout.write(`  - ${p}\n`);
      }
    }
  }
}
