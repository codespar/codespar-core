import { CodeSpar } from "@codespar/sdk";
import type { VerificationStatusResult } from "@codespar/sdk";
import { CliError } from "../config.js";
import { info, json, success, warn } from "../output.js";

interface VerificationStatusCommandOptions {
  apiKey: string;
  baseUrl: string;
  user?: string;
  stream?: boolean;
  timeout?: string;
  json?: boolean;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * KYC sibling of payment-status. Default poll once; `--stream` opens
 * an SSE channel and prints each `update` until the terminal frame.
 * Ctrl+C cancels via AbortController.
 */
export async function verificationStatusCommand(
  toolCallId: string,
  opts: VerificationStatusCommandOptions,
): Promise<void> {
  if (!toolCallId) {
    throw new CliError(
      "tool-call id is required. Example: `codespar verification-status tcl_abc123`",
    );
  }

  const timeoutMs = opts.timeout ? Number(opts.timeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError("--timeout must be a positive integer (milliseconds).");
  }

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const session = await cs.create(userId, { servers: [] });

  try {
    if (opts.stream) {
      await runStream(session, toolCallId, timeoutMs, Boolean(opts.json));
    } else {
      const result = await session.verificationStatus(toolCallId);
      renderResult(result, Boolean(opts.json));
    }
  } finally {
    await session.close();
  }
}

async function runStream(
  session: Awaited<ReturnType<CodeSpar["create"]>>,
  toolCallId: string,
  timeoutMs: number,
  asJson: boolean,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onSigint = () => {
    warn("Aborted by user.");
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    let updates = 0;
    const final = await session.verificationStatusStream(toolCallId, {
      signal: controller.signal,
      onUpdate: (envelope) => {
        updates++;
        if (asJson) {
          json(envelope);
        } else {
          info(
            `update #${updates}: verification_status=${envelope.verification_status}  events=${envelope.events.length}`,
          );
        }
      },
    });
    renderResult(final, asJson);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new CliError("verification-status stream timed out or was aborted.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSigint);
  }
}

function renderResult(result: VerificationStatusResult, asJson: boolean): void {
  if (asJson) {
    json(result);
    return;
  }
  success(`verification_status: ${result.verification_status}`);
  info(`tool_call_id: ${result.tool_call_id}`);
  info(`original_status: ${result.original_status}`);
  info(`idempotency_key: ${result.idempotency_key ?? "-"}`);
  if (result.hosted_url) info(`hosted_url: ${result.hosted_url}`);
  info(`events: ${result.events.length}`);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
