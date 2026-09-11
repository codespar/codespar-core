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

/** Scalars a generic table can print in a cell. */
function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "-";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length <= 40 ? s : s.slice(0, 39) + "…";
}

/** The array inside a single-collection envelope (`{ data: [...] }`), if any. */
function collectionOf(value: Record<string, unknown>): [string, unknown[]] | undefined {
  const arrays = Object.entries(value).filter(([, v]) => Array.isArray(v));
  if (arrays.length !== 1) return undefined;
  const [key, list] = arrays[0] as [string, unknown[]];
  return [key, list];
}

const MAX_COLUMNS = 6;

/**
 * Print an API payload without knowing its shape. A list — bare or inside
 * a single-array envelope — becomes a table over the scalar fields its
 * items share; anything else prints as JSON. Deliberately dumb: a
 * generic renderer that guesses at semantics would show a number under
 * the wrong heading, and the payload is the product here.
 */
export function renderResult(value: unknown): void {
  if (value === undefined || value === null) {
    process.stderr.write(c.dim("(no content)\n"));
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(value.endsWith("\n") ? value : value + "\n");
    return;
  }
  if (Array.isArray(value)) {
    renderList(value);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const collection = collectionOf(record);
    if (collection && collection[1].length > 0) {
      const [key, list] = collection;
      const rest = Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
      renderList(list);
      if (Object.keys(rest).length > 0) {
        process.stdout.write("\n");
        json(rest);
      }
      return;
    }
  }
  json(value);
}

function renderList(list: readonly unknown[]): void {
  if (list.length === 0) {
    process.stderr.write(c.dim("(no results)\n"));
    return;
  }
  if (!list.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
    json(list);
    return;
  }
  const rows = list as ReadonlyArray<Record<string, unknown>>;
  const columns: string[] = [];
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (isScalar(v) && !columns.includes(k)) columns.push(k);
    }
  }
  if (columns.length === 0) {
    json(list);
    return;
  }
  const shown = columns.slice(0, MAX_COLUMNS);
  table(
    shown,
    rows.map((row) => shown.map((k) => cell(row[k]))),
  );
  if (columns.length > shown.length) {
    process.stderr.write(
      c.dim(`(${columns.length - shown.length} more field(s) per row — use --json)\n`),
    );
  }
}
