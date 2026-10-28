/**
 * ASCII banner for the CodeSpar CLI.
 *
 * Printed once when the user runs the bare `codespar` command (no args)
 * or `codespar --help`, and at the top of the interactive login flow.
 * Silenced when stdout is not a TTY, when `--json` is active, or when
 * `NO_BANNER=1` is set — so piped scripts and CI remain clean.
 */
import { c } from "./output.js";

const LOGO = [
  "  ██████╗ ██████╗ ██████╗ ███████╗███████╗██████╗  █████╗ ██████╗ ",
  " ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██╔══██╗",
  " ██║     ██║   ██║██║  ██║█████╗  ███████╗██████╔╝███████║██████╔╝",
  " ██║     ██║   ██║██║  ██║██╔══╝  ╚════██║██╔═══╝ ██╔══██║██╔══██╗",
  " ╚██████╗╚██████╔╝██████╔╝███████╗███████║██║     ██║  ██║██║  ██║",
  "  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝",
];

function shouldRender(): boolean {
  if (process.env.NO_BANNER === "1") return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

/** The logo as the site draws it: solid blocks in the terminal's own foreground, the outline in gray. */
function shade(line: string): string {
  return line.replace(/[█]+|[^█]+/g, (run) => (run[0] === "█" ? c.bold(run) : c.gray(run)));
}

/** Print the banner. No-op when stdout is not a TTY or NO_BANNER=1. */
export function printBanner(version: string): void {
  if (!shouldRender()) return;

  const out = process.stdout;
  out.write("\n");
  for (const line of LOGO) out.write(shade(line) + "\n");
  out.write(
    `\n  ${c.green("@codespar/cli")}  ${c.gray("·")}  ${c.gray(`v${version}`)}  ${c.gray("·")}  ${c.gray("The agentic OS for money movement, in your shell.")}\n`,
  );
  const width = Math.min(process.stdout.columns ?? 80, 96);
  out.write(`${c.gray("─".repeat(width))}\n\n`);
}
