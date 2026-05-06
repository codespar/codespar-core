import { CodeSpar } from "@codespar/sdk";
import type { DiscoverOptions, DiscoverResult, DiscoverToolMatch } from "@codespar/sdk";
import { CliError } from "../config.js";
import { c, info, json, table } from "../output.js";

interface DiscoverCommandOptions {
  apiKey: string;
  baseUrl: string;
  user?: string;
  category?: string;
  country?: string;
  limit?: string;
  json?: boolean;
}

/**
 * Wraps `session.discover(useCase)`. Discover spans the whole catalog,
 * so we open a session with `servers: []` — no per-server connection
 * is required. The default `--limit` is 10 (server clamps to 1..20).
 */
export async function discoverCommand(
  query: string,
  opts: DiscoverCommandOptions,
): Promise<void> {
  if (!query) {
    throw new CliError(
      "A search query is required. Example: `codespar discover \"issue an NF-e\"`",
    );
  }

  const limit = opts.limit ? Number(opts.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new CliError("--limit must be a positive integer.");
  }

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const session = await cs.create(userId, { servers: [] });

  try {
    const discoverOpts: DiscoverOptions = {};
    if (opts.category) discoverOpts.category = opts.category;
    if (opts.country) discoverOpts.country = opts.country;
    if (limit !== undefined) discoverOpts.limit = limit;

    const result: DiscoverResult = await session.discover(query, discoverOpts);

    if (opts.json) {
      json(result);
      return;
    }

    renderDiscoverResult(result, limit ?? 10);
  } finally {
    await session.close();
  }
}

function renderDiscoverResult(result: DiscoverResult, displayLimit: number): void {
  info(
    `Strategy: ${result.search_strategy}  ·  use_case: ${JSON.stringify(result.use_case)}`,
  );

  const rows: string[][] = [];
  const matches: DiscoverToolMatch[] = [];
  if (result.recommended) matches.push(result.recommended);
  for (const m of result.related) {
    if (matches.length >= displayLimit) break;
    matches.push(m);
  }

  if (matches.length === 0) {
    process.stderr.write(c.dim("(no matches)\n"));
    return;
  }

  matches.forEach((m, idx) => {
    const score =
      m.cosine_distance !== null
        ? (1 - m.cosine_distance).toFixed(3)
        : m.trigram_similarity !== null
          ? m.trigram_similarity.toFixed(3)
          : "-";
    const desc =
      m.description.length > 60 ? m.description.slice(0, 57) + "..." : m.description;
    rows.push([
      String(idx + 1),
      score,
      `${m.server_id}.${m.tool_name}`,
      m.connection_status,
      desc,
    ]);
  });

  table(["#", "SCORE", "SERVER.TOOL", "CONN", "DESCRIPTION"], rows);

  if (result.next_steps.length > 0) {
    process.stdout.write("\n");
    info("Next steps:");
    for (const step of result.next_steps) {
      process.stdout.write(`  - ${step}\n`);
    }
  }
}
