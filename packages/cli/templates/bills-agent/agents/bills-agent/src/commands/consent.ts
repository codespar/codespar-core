/**
 * `npm run consent [--yes]`: runs the partner-surface consent for a new
 * mandate with the test key (the titular authorizes at the keyboard), stores
 * the signed envelope locally and credits the sandbox. Module `embedded-consent`.
 */
import { resolve } from "node:path";
import { stderr } from "node:process";
import { createCodeSparClient, loadMandate } from "@codespar/agent-core";
import { runEmbeddedConsent } from "../modules/embedded-consent.js";
import { AGENT_DIR, MANDATE_PATH, readDotEnv } from "../setup.js";

readDotEnv();
const say = (l: string) => stderr.write(l + "\n");
const api = createCodeSparClient({ apiKey: process.env["CODESPAR_API_KEY"], baseUrl: process.env["CODESPAR_API_URL"], projectId: process.env["CODESPAR_PROJECT_ID"] });
const example = loadMandate(resolve(AGENT_DIR, "mandate.example.json"));
const yes = process.argv.includes("--yes");
const confirm = async (question: string): Promise<boolean> => {
  if (yes) return true;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return /^(s|sim|y|yes)$/i.test(answer);
};
const mandate = await runEmbeddedConsent({ api, example, mandatePath: MANDATE_PATH, say, confirm });
say(`mandato ${mandate.id} salvo em .codespar/mandate.json`);
