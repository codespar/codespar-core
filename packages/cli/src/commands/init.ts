import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../config.js";
import { c, info, success } from "../output.js";

/**
 * Project scaffolder. Copies a template from packages/cli/templates/<slug>
 * into the target directory and substitutes {{name}} placeholders.
 *
 * Templates are shipped inside the published package — `files` in
 * package.json needs to include "templates" so they end up on npm.
 */

interface Template {
  slug: string;
  label: string;
  description: string;
  framework: string;
}

const TEMPLATES: Template[] = [
  {
    slug: "pix-agent",
    label: "Pix Payment Agent",
    description: "Minimal Pix charge + WhatsApp notification via OpenAI",
    framework: "OpenAI",
  },
  {
    slug: "ecommerce-checkout",
    label: "E-Commerce Checkout",
    description: "Full Complete Loop: checkout → invoice → ship → notify (Claude)",
    framework: "Claude",
  },
  {
    slug: "streaming-chat",
    label: "Streaming Chat",
    description: "Next.js 15 + Vercel AI SDK with token-by-token streaming",
    framework: "Next.js + Vercel AI",
  },
  {
    slug: "multi-tenant",
    label: "Multi-Tenant Agent",
    description: "SaaS pattern — one API key, N tenants, per-tenant billing",
    framework: "Next.js + OpenAI",
  },
];

interface InitOptions {
  template?: string;
  yes?: boolean;
}

export async function initCommand(name: string, opts: InitOptions): Promise<void> {
  if (!name) throw new CliError("Project name is required. Example: `codespar init my-agent`");

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

  const template = await pickTemplate(opts);

  info(`Creating ${c.bold(name)} using the ${c.bold(template.label)} template...`);

  const templatesRoot = resolveTemplatesDir();
  const source = join(templatesRoot, template.slug);

  await copyTemplate(source, target, { name });

  process.stdout.write("\n");
  success(`Created ${name}/`);
  process.stdout.write(
    [
      "",
      "Next steps:",
      `  cd ${name}`,
      "  cp .env.example .env   # then fill in your keys",
      "  npm install",
      "  npm run dev",
      "",
    ].join("\n"),
  );
}

async function pickTemplate(opts: InitOptions): Promise<Template> {
  if (opts.template) {
    const t = TEMPLATES.find((x) => x.slug === opts.template);
    if (!t) {
      throw new CliError(
        `Unknown template "${opts.template}". Available: ${TEMPLATES.map((x) => x.slug).join(", ")}`,
      );
    }
    return t;
  }

  if (opts.yes) return TEMPLATES[0];

  // Interactive pick
  process.stdout.write(c.bold("Choose a template:\n\n"));
  TEMPLATES.forEach((t, i) => {
    process.stdout.write(`  ${c.blue(`${i + 1}.`)} ${c.bold(t.label)} ${c.dim(`(${t.framework})`)}\n`);
    process.stdout.write(`     ${c.dim(t.description)}\n\n`);
  });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`Pick a number [1-${TEMPLATES.length}] (default 1): `)).trim();
    const index = answer === "" ? 0 : Number.parseInt(answer, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= TEMPLATES.length) {
      throw new CliError(`Invalid choice: ${answer}`);
    }
    return TEMPLATES[index];
  } finally {
    rl.close();
  }
}

function resolveTemplatesDir(): string {
  // When running from dist/, __dirname is packages/cli/dist/commands.
  // Templates live at packages/cli/templates, so go up two levels.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "templates");
}

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
    const outName = substituteAll(entry.name, vars);
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
