/**
 * Output helpers. Zero deps — ANSI color codes directly, disabled when
 * `NO_COLOR` is set, `FORCE_COLOR=0`, or stdout is not a TTY. This keeps
 * piped output (`| jq`, `| grep`) plain text without us having to strip.
 */
const USE_COLOR =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY);

function wrap(open: string, close: string): (s: string) => string {
  return (s: string) => (USE_COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const c = {
  dim: wrap("2", "22"),
  bold: wrap("1", "22"),
  green: wrap("32", "39"),
  red: wrap("31", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  gray: wrap("90", "39"),
};

/** Print a compact key/value block. Used for `whoami` and `servers show`. */
export function kv(pairs: Array<[string, string]>): void {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    process.stdout.write(`${c.gray(k.padEnd(width))}  ${v}\n`);
  }
}

/** Print a table with aligned columns. `headers` are shown in bold gray. */
export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    process.stderr.write(c.dim("(no results)\n"));
    return;
  }
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");

  process.stdout.write(c.bold(c.gray(fmt(headers))) + "\n");
  for (const row of rows) process.stdout.write(fmt(row) + "\n");
}

/** Print valid JSON to stdout — for `--json` flag / scripting. */
export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Info message to stderr (keeps stdout clean for scripting). */
export function info(msg: string): void {
  process.stderr.write(`${c.blue("ℹ")} ${msg}\n`);
}
export function success(msg: string): void {
  process.stderr.write(`${c.green("✓")} ${msg}\n`);
}
export function warn(msg: string): void {
  process.stderr.write(`${c.yellow("⚠")} ${msg}\n`);
}
