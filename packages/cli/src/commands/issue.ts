import { CodeSpar } from "@codespar/sdk";
import type { IssueArgs, IssueResult } from "@codespar/sdk";
import { CliError } from "../config.js";
import { info, json, success } from "../output.js";
import { resolveMetaInput } from "./meta-input.js";

interface IssueCommandOptions {
  apiKey: string;
  baseUrl: string;
  project?: string;
  user?: string;
  input?: string;
  inputFile?: string;
  json?: boolean;
}

const EXAMPLE =
  '{"action":"card-virtual","cardholder_id":"usr_123","program_id":"afg_123"}';

/**
 * Wraps `session.issue(args)` — issue a virtual/physical agent spend card,
 * freeze/unfreeze/cancel one, or read a card's status (Pomelo). The
 * meta-tool router resolves the rail, so no `--server`.
 */
export async function issueCommand(opts: IssueCommandOptions): Promise<void> {
  const args = (await resolveMetaInput(opts, "issue", EXAMPLE)) as unknown as IssueArgs;
  validateIssueArgs(args);

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    projectId: opts.project,
  });
  const session = await cs.create(userId, { servers: [] });

  try {
    const result: IssueResult = await session.issue(args);

    if (opts.json) {
      json(result);
      return;
    }

    success(`issue ${args.action} → ${result.status ?? "ok"}`);
    if (result.id) info(`Card id: ${result.id}`);
    if (result.card_type) info(`Type: ${result.card_type}`);
    if (result.last_four) info(`Last four: ${result.last_four}`);
    if (result.cardholder_id) info(`Cardholder: ${result.cardholder_id}`);
  } finally {
    await session.close();
  }
}

export function validateIssueArgs(args: IssueArgs): void {
  const actions = ["card-virtual", "card-physical", "card-control", "card-get"];
  if (!args.action || !actions.includes(args.action)) {
    throw new CliError(`issue.action must be one of: ${actions.join(", ")}.`);
  }
  if (args.action === "card-virtual" || args.action === "card-physical") {
    if (!args.cardholder_id) throw new CliError("issue.cardholder_id is required to issue a card.");
    if (!args.program_id) throw new CliError("issue.program_id is required to issue a card.");
  }
  if (args.action === "card-physical" && !args.shipping_address) {
    throw new CliError("issue.shipping_address is required when action=card-physical.");
  }
  if ((args.action === "card-control" || args.action === "card-get") && !args.card_id) {
    throw new CliError("issue.card_id is required when action=card-control | card-get.");
  }
  if (args.action === "card-control" && !args.control) {
    throw new CliError("issue.control (freeze | unfreeze | cancel) is required when action=card-control.");
  }
}
