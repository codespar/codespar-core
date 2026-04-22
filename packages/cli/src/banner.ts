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

/** Print the banner. No-op when stdout is not a TTY or NO_BANNER=1. */
export function printBanner(version: string): void {
  if (!shouldRender()) return;

  const out = process.stdout;
  out.write("\n");
  for (const line of LOGO) out.write(c.blue(line) + "\n");
  out.write(
    `\n  ${c.bold("Commerce infrastructure for AI agents in Latin America")}\n`,
  );
  out.write(
    `  ${c.gray(`v${version}  ·  codespar.dev/docs/cli  ·  MIT`)}\n\n`,
  );
}
