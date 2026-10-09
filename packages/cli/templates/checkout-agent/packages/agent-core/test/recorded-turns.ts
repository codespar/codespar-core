import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every turn a person types in a recorded scenario or WhatsApp conversation
 * under `root/agents`: all Portuguese. `root` is this repository, with every
 * agent, or a scaffold made by `codespar init --template`, with one.
 */
export function recordedTurns(root: string): string[] {
  const out: string[] = [];
  for (const agent of readdirSync(join(root, "agents"))) {
    for (const dir of ["scenarios", join("channels", "whatsapp")]) {
      let files: string[] = [];
      try {
        files = readdirSync(join(root, "agents", agent, dir)).filter((f) => f.endsWith(".json") && f !== "templates.json");
      } catch {
        continue;
      }
      for (const f of files) {
        const doc = JSON.parse(readFileSync(join(root, "agents", agent, dir, f), "utf8")) as { turns?: Array<{ input?: string; text?: string }> };
        for (const t of doc.turns ?? []) {
          const text = t.input ?? t.text;
          if (typeof text === "string") out.push(text);
        }
      }
    }
  }
  return out;
}
