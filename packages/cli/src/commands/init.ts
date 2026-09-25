import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../config.js";
import { c, info, json, success } from "../output.js";

/**
 * Project scaffolder. Copies a template from packages/cli/templates/<slug>
 * into the target directory and substitutes {{name}} placeholders.
 *
 * Templates are shipped inside the published package — `files` in
 * package.json needs to include "templates" so they end up on npm.
 *
 * Two families live there. The framework templates are hand-written here.
 * The kit templates are the agents of codespar/agent-starter-kits, copied
 * in at release time by `scripts/sync-kit-templates.mjs` and described by
 * `templates/kits.lock.json`; `init` reads that lock and never reaches the
 * network, so `--template bills-agent` scaffolds the same bytes offline
 * as it does online, pinned to the kits commit the lock records.
 */

export interface Template {
  slug: string;
  label: string;
  description: string;
  framework: string;
  kind: "framework" | "kit";
  nextSteps: string[];
}

const FRAMEWORK_NEXT_STEPS = ["cp .env.example .env   # then fill in your keys", "npm install", "npm run dev"];

const FRAMEWORK_TEMPLATES: Template[] = [
  {
    slug: "pix-agent",
    label: "Pix Payment Agent",
    description: "Minimal Pix charge + WhatsApp notification via OpenAI",
    framework: "OpenAI",
    kind: "framework",
    nextSteps: FRAMEWORK_NEXT_STEPS,
  },
  {
    slug: "ecommerce-checkout",
    label: "E-Commerce Checkout",
    description: "Full Complete Loop: checkout → invoice → ship → notify (Claude)",
    framework: "Claude",
    kind: "framework",
    nextSteps: FRAMEWORK_NEXT_STEPS,
  },
  {
    slug: "streaming-chat",
    label: "Streaming Chat",
    description: "Next.js 15 + Vercel AI SDK with token-by-token streaming",
    framework: "Next.js + Vercel AI",
    kind: "framework",
    nextSteps: FRAMEWORK_NEXT_STEPS,
  },
  {
    slug: "multi-tenant",
    label: "Multi-Tenant Agent",
    description: "SaaS pattern — one API key, N tenants, per-tenant billing",
    framework: "Next.js + OpenAI",
    kind: "framework",
    nextSteps: FRAMEWORK_NEXT_STEPS,
  },
];

export const KITS_LOCK_BASENAME = "kits.lock.json";

interface KitsLock {
  format: number;
  kits_repo: string;
  kits_ref: string;
  commit: string;
  templates: Record<
    string,
    { description: string; version: string; cli: string; next_steps: string[]; hash: string }
  >;
}

/**
 * The kit templates the packaged lock describes. A package without the lock
 * simply has no kit templates: the framework ones must keep working from a
 * tarball that predates the lock, and the release gate is what guarantees a
 * tarball that has it also has every tree it names.
 */
export function loadKitTemplates(templatesRoot: string = resolveTemplatesDir()): Template[] {
  let raw: string;
  try {
    raw = readFileSync(join(templatesRoot, KITS_LOCK_BASENAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lock = JSON.parse(raw) as KitsLock;
  if (lock.format !== 1) {
    throw new CliError(`${KITS_LOCK_BASENAME} has format ${lock.format}; this CLI reads format 1. Is the package installation corrupted?`);
  }
  const shortCommit = lock.commit.slice(0, 7);
  return Object.entries(lock.templates)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, entry]) => ({
      slug,
      label: `${slug} ${entry.version}`,
      description: entry.description,
      framework: `agent-starter-kits @ ${shortCommit}, agent-core vendored`,
      kind: "kit",
      nextSteps: entry.next_steps,
    }));
}

/**
 * The `--template` help, one line per template, DERIVED from the packaged
 * templates rather than spelled out here.
 *
 * It used to be a hand-written sentence naming two kit slugs. Kits `8f130b7`
 * brought four, and a hand-written list is exactly the thing that goes stale on
 * the next agent that lands — so the names and their one-liners come from the
 * lock, which the sync writes.
 *
 * It CANNOT throw. This runs while commander is being built, before any command
 * has been chosen, so a corrupt or absent lock here would break `--help` and
 * every other subcommand with it. A generic line is a worse help text; a stack
 * trace on `codespar login` is a broken CLI.
 */
export function templateOptionHelp(templatesRoot: string = resolveTemplatesDir()): string {
  const generic = "Template slug; `--list` shows the available templates with a one-line description each";
  let templates: Template[];
  try {
    templates = listTemplates(templatesRoot);
  } catch {
    return generic;
  }
  if (templates.length === 0) return generic;
  const width = Math.max(...templates.map((t) => t.slug.length));
  return [`${generic}:`, ...templates.map((t) => `  ${t.slug.padEnd(width)}  ${t.description}`)].join("\n");
}

export function listTemplates(templatesRoot: string = resolveTemplatesDir()): Template[] {
  const kits = loadKitTemplates(templatesRoot);
  const taken = new Set(FRAMEWORK_TEMPLATES.map((t) => t.slug));
  for (const kit of kits) {
    if (taken.has(kit.slug)) {
      throw new CliError(`Template slug "${kit.slug}" is both a framework template and a kit template. Is the package installation corrupted?`);
    }
  }
  return [...FRAMEWORK_TEMPLATES, ...kits];
}

interface InitOptions {
  template?: string;
  yes?: boolean;
  list?: boolean;
  json?: boolean;
}

export async function initCommand(name: string | undefined, opts: InitOptions): Promise<void> {
  if (opts.list) {
    printTemplateList(listTemplates(), Boolean(opts.json));
    return;
  }

  if (!name) throw new CliError("Project name is required. Example: `codespar init my-agent` (or `codespar init --list`)");

  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
    throw new CliError(
      "Project name must start with a letter/number and contain only letters, digits, dashes, and underscores.",
    );
  }

  const target = resolve(process.cwd(), name);

  // Refuse to clobber an existing non-empty directory.
  try {
    const existing = await readdir(target);
    if (existing.length > 0) {
      throw new CliError(`Directory ${name}/ already exists and is not empty. Choose a different name or delete it first.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const templates = listTemplates();
  const template = await pickTemplate(templates, opts);

  info(`Creating ${c.bold(name)} using the ${c.bold(template.label)} template...`);

  const templatesRoot = resolveTemplatesDir();
  const source = join(templatesRoot, template.slug);

  await copyTemplate(source, target, { name });

  process.stdout.write("\n");
  success(`Created ${name}/`);
  // Sem isto, `codespar init x --json` escrevia um roteiro de proximos passos
  // no stdout, que e justamente onde quem automatiza espera um documento.
  if (opts.json) {
    json({ created: name, template: template.slug, kind: template.kind, path: target, next_steps: template.nextSteps });
    return;
  }
  process.stdout.write(["", "Next steps:", `  cd ${name}`, ...template.nextSteps.map((s) => `  ${s}`), ""].join("\n"));
}

function printTemplateList(templates: Template[], asJson: boolean): void {
  if (asJson) {
    json({ templates: templates.map(({ slug, label, description, framework, kind }) => ({ slug, label, description, framework, kind })) });
    return;
  }
  const width = Math.max(...templates.map((t) => t.slug.length));
  process.stdout.write(c.bold("Templates:\n\n"));
  for (const t of templates) {
    process.stdout.write(`  ${c.bold(t.slug.padEnd(width))}  ${t.label} ${c.dim(`(${t.framework})`)}\n`);
    process.stdout.write(`  ${"".padEnd(width)}  ${c.dim(t.description)}\n\n`);
  }
  process.stdout.write(c.dim("codespar init <name> --template <slug>\n"));
}

async function pickTemplate(templates: Template[], opts: InitOptions): Promise<Template> {
  if (opts.template) {
    const t = templates.find((x) => x.slug === opts.template);
    if (!t) {
      throw new CliError(
        `Unknown template "${opts.template}". Available: ${templates.map((x) => x.slug).join(", ")} (see \`codespar init --list\`)`,
      );
    }
    return t;
  }

  if (opts.yes) return templates[0];

  // Mesma armadilha do `login`: sem TTY o menu e impresso, a pergunta nunca
  // volta e o processo sai 0 sem escrever um arquivo.
  if (!stdin.isTTY) {
    throw new CliError(
      "No terminal to prompt on. Re-run with `--yes` for the default template, or pass `--template <slug>`.",
    );
  }

  // Interactive pick
  process.stdout.write(c.bold("Choose a template:\n\n"));
  templates.forEach((t, i) => {
    process.stdout.write(`  ${c.blue(`${i + 1}.`)} ${c.bold(t.label)} ${c.dim(`(${t.framework})`)}\n`);
    process.stdout.write(`     ${c.dim(t.description)}\n\n`);
  });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`Pick a number [1-${templates.length}] (default 1): `)).trim();
    const index = answer === "" ? 0 : Number.parseInt(answer, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= templates.length) {
      throw new CliError(`Invalid choice: ${answer}`);
    }
    return templates[index];
  } finally {
    rl.close();
  }
}

export function resolveTemplatesDir(): string {
  // When running from dist/, __dirname is packages/cli/dist/commands.
  // Templates live at packages/cli/templates, so go up two levels.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "templates");
}

/**
 * npm drops every `.gitignore` from a tarball, in any directory, so a
 * template ships it as `_gitignore` and it is renamed back on the way out.
 */
const RENAME_ON_COPY: Record<string, string> = { _gitignore: ".gitignore" };

async function copyTemplate(
  source: string,
  target: string,
  vars: Record<string, string>,
): Promise<void> {
  const stats = await stat(source).catch(() => null);
  if (!stats) throw new CliError(`Template not found at ${source}. Is the package installation corrupted?`);

  await mkdir(target, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(source, entry.name);
    // Substitute placeholders in file names too (rare but cheap)
    const outName = substituteAll(RENAME_ON_COPY[entry.name] ?? entry.name, vars);
    const dstPath = join(target, outName);

    if (entry.isDirectory()) {
      await copyTemplate(srcPath, dstPath, vars);
      continue;
    }

    // Binary detection is heuristic — read as utf-8 and substitute if
    // it decodes cleanly. Good enough for templates which are all text.
    const buf = await readFile(srcPath);
    const text = buf.toString("utf-8");
    const rendered = substituteAll(text, vars);
    await writeFile(dstPath, rendered, "utf-8");
  }
}

function substituteAll(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}
