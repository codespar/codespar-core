/**
 * `npm run check`: the manifest is the index, and the files it points to
 * must agree with it. Fails on a contradiction between `agent.yaml` and
 * `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` or `channels/`, on
 * `AGENTS.md` and `CLAUDE.md` diverging, and on a missing `mcp`, `cli` or
 * `schema`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConversationScriptSchema, TemplateRegistrySchema, TEMPLATE_REGISTRY_FILE, templateArity } from "./channels.js";
import { GuardrailsSchema } from "./guardrails.js";
import { loadManifest, ManifestSchema, type LoadedManifest } from "./manifest.js";
import { MandateSchema } from "./mandate.js";
import { ToolsFileSchema } from "./tools.js";
import { canonicalJson } from "./hash.js";
import { PUBLISHED_EVENTS, isPublishedEvent } from "./events.js";

export interface CheckFinding {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface CheckReport {
  ok: boolean;
  agent: string | null;
  findings: CheckFinding[];
}

export function checkAgent(agentDir: string): CheckReport {
  const findings: CheckFinding[] = [];
  const error = (code: string, message: string) => findings.push({ level: "error", code, message });
  const warning = (code: string, message: string) => findings.push({ level: "warning", code, message });

  const manifestPath = join(agentDir, "agent.yaml");
  if (!existsSync(manifestPath)) {
    error("manifest_missing", `${manifestPath} does not exist`);
    return { ok: false, agent: null, findings };
  }

  // Pinned versions and schema are checked on the raw document, so the message names the field instead of a Zod path.
  const raw = parseYaml(readFileSync(manifestPath, "utf8")) as Record<string, unknown> | null;
  for (const field of ["schema", "mcp", "cli"]) {
    if (!raw || raw[field] === undefined) error("manifest_field_missing", `agent.yaml has no \`${field}\``);
  }
  // The events an agent declares must be ones the API publishes; the list is the core's (events.ts), the manifest only names entries of it.
  for (const name of Array.isArray(raw?.["events"]) ? raw["events"] : []) {
    if (typeof name === "string" && !isPublishedEvent(name)) error("events_unknown", `agent.yaml declares the event \`${name}\`, which the API does not publish; known: ${PUBLISHED_EVENTS.join(", ")}`);
  }

  let loaded: LoadedManifest;
  try {
    loaded = loadManifest(manifestPath);
  } catch (err) {
    error("manifest_invalid", err instanceof Error ? err.message : String(err));
    return { ok: false, agent: typeof raw?.["name"] === "string" ? (raw["name"] as string) : null, findings };
  }
  const { manifest } = loaded;

  // tools.json
  let toolNames: string[] = [];
  // Hoisted: the receipt-verification rule below needs it, and only a payment
  // seals a receipt.
  let hasPayment = false;
  const toolsPath = loaded.resolvePath(manifest.tools);
  if (!existsSync(toolsPath)) error("tools_missing", `${manifest.tools} does not exist`);
  else {
    const parsed = ToolsFileSchema.safeParse(JSON.parse(readFileSync(toolsPath, "utf8")));
    if (!parsed.success) error("tools_invalid", parsed.error.message);
    else {
      toolNames = [...parsed.data.meta_tools, ...parsed.data.local_tools].map((t) => t.name);
      hasPayment = parsed.data.meta_tools.some((t) => t.effect === "payment");
      const declaresPixOut = manifest.maturity["pix-out"] !== undefined;
      if (declaresPixOut && !hasPayment) error("tools_contradict_manifest", "agent.yaml declares pix-out maturity but tools.json has no payment meta-tool");
      if (!declaresPixOut && hasPayment) error("tools_contradict_manifest", "tools.json has a payment meta-tool but agent.yaml declares no pix-out maturity");
      const hasCharge = parsed.data.meta_tools.some((t) => t.effect === "charge");
      const declaresReceivables = manifest.maturity["bolepix-receivables"] !== undefined;
      if (declaresReceivables && !hasCharge) error("tools_contradict_manifest", "agent.yaml declares bolepix-receivables maturity but tools.json has no charge meta-tool");
      if (!declaresReceivables && hasCharge) error("tools_contradict_manifest", "tools.json has a charge meta-tool but agent.yaml declares no bolepix-receivables maturity");
    }
  }

  // guardrails.json
  const guardrailsPath = loaded.resolvePath(manifest.guardrails);
  if (!existsSync(guardrailsPath)) error("guardrails_missing", `${manifest.guardrails} does not exist`);
  else {
    const parsed = GuardrailsSchema.safeParse(JSON.parse(readFileSync(guardrailsPath, "utf8")));
    if (!parsed.success) error("guardrails_invalid", parsed.error.message);
    else {
      if (parsed.data.approval !== manifest.default_approval) {
        error("guardrails_contradict_manifest", `guardrails.approval is ${parsed.data.approval}; agent.yaml default_approval is ${manifest.default_approval}`);
      }
      if (canonicalJson(parsed.data.escalate_above ?? null) !== canonicalJson(manifest.escalate_above ?? null)) {
        error("guardrails_contradict_manifest", "guardrails.escalate_above differs from agent.yaml escalate_above");
      }
    }
  }

  // channels: the declaration and what the agent ships, checked BOTH ways.
  //
  // A channel is the runner's, but the conversations are the agent's, so
  // `channels: [terminal, whatsapp]` is a claim about files. Declaring
  // whatsapp without shipping a conversation gives a reader a channel that
  // cannot be driven; shipping one without declaring it hides a surface the
  // agent answers on. Both are errors, and a script that no longer parses is
  // one too, because the simulator and this check read the same schema.
  if (!manifest.channels.includes("terminal")) {
    error("channels_terminal_missing", "agent.yaml must declare the terminal channel: `npm start` opens it and it needs no account");
  }
  // `templates.json` is the one file in there that is NOT a conversation: it
  // is the local registry of the templates the agent declares it sends, which
  // is what makes "this name was never registered here" a refusal the channel
  // can make instead of a 400 from Meta. A conversation therefore cannot be
  // called `templates`, and this is the only place that says so.
  const whatsappDir = join(agentDir, "channels", "whatsapp");
  const scripts = existsSync(whatsappDir) ? readdirSync(whatsappDir).filter((f) => f.endsWith(".json") && f !== TEMPLATE_REGISTRY_FILE).sort() : [];
  if (manifest.channels.includes("whatsapp") && scripts.length === 0) {
    error("channels_not_shipped", "agent.yaml declares the whatsapp channel but channels/whatsapp/ ships no conversation for the simulator to drive");
  }
  if (!manifest.channels.includes("whatsapp") && scripts.length > 0) {
    error("channels_undeclared", `channels/whatsapp/ ships ${scripts.length} conversation(s) but agent.yaml does not declare the whatsapp channel`);
  }
  for (const file of scripts) {
    const parsed = ConversationScriptSchema.safeParse(JSON.parse(readFileSync(join(whatsappDir, file), "utf8")));
    if (!parsed.success) error("channels_script_invalid", `channels/whatsapp/${file}: ${parsed.error.message}`);
    else if (parsed.data.name !== file.replace(/\.json$/, "")) error("channels_script_invalid", `channels/whatsapp/${file} declares name ${parsed.data.name}`);
  }
  const registryPath = join(whatsappDir, TEMPLATE_REGISTRY_FILE);
  if (existsSync(registryPath)) {
    const parsed = TemplateRegistrySchema.safeParse(JSON.parse(readFileSync(registryPath, "utf8")));
    if (!parsed.success) error("channels_templates_invalid", `channels/whatsapp/${TEMPLATE_REGISTRY_FILE}: ${parsed.error.message}`);
    else {
      // A body with no placeholder takes no variables, and one with `{{3}}`
      // and no `{{2}}` cannot be filled: Meta numbers them from 1 without
      // gaps, and a send that skips one is a 132000 nobody sees until the
      // first real message goes out.
      for (const template of parsed.data.templates) {
        const arity = templateArity(template.body);
        for (let n = 1; n <= arity; n += 1) {
          if (!new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`).test(template.body)) {
            error("channels_templates_invalid", `channels/whatsapp/${TEMPLATE_REGISTRY_FILE}: ${template.name} uses {{${arity}}} but never {{${n}}}; Meta numbers variables from 1 with no gaps`);
          }
        }
      }
    }
  }

  // mandate.example.json
  const mandatePath = loaded.resolvePath(manifest.mandate_schema);
  if (!existsSync(mandatePath)) error("mandate_missing", `${manifest.mandate_schema} does not exist`);
  else {
    const parsed = MandateSchema.safeParse(JSON.parse(readFileSync(mandatePath, "utf8")));
    if (!parsed.success) error("mandate_invalid", parsed.error.message);
    else if (parsed.data.agent_id !== manifest.name) error("mandate_contradicts_manifest", `mandate.example.json agent_id is ${parsed.data.agent_id}; agent.yaml name is ${manifest.name}`);
  }

  // SYSTEM_PROMPT.md: must exist, must name the agent, must not name a tool tools.json does not have, must not promise third-party verification.
  const promptPath = join(agentDir, "SYSTEM_PROMPT.md");
  if (!existsSync(promptPath)) error("prompt_missing", "SYSTEM_PROMPT.md does not exist");
  else {
    const prompt = readFileSync(promptPath, "utf8");
    if (!prompt.includes(manifest.name)) error("prompt_contradicts_manifest", `SYSTEM_PROMPT.md never names ${manifest.name}`);
    for (const named of prompt.match(/\bcodespar_[a-z_]+\b/g) ?? []) {
      if (!toolNames.includes(named)) error("prompt_contradicts_tools", `SYSTEM_PROMPT.md names ${named}, which tools.json does not list`);
    }
    for (const mode of ["human", "mandate"] as const) {
      if (prompt.includes(`approval: ${mode}`) && !manifest.approval.includes(mode)) error("prompt_contradicts_manifest", `SYSTEM_PROMPT.md mentions approval: ${mode}, which agent.yaml does not support`);
    }
  }

  // AGENTS.md and CLAUDE.md identical.
  const agentsMd = join(agentDir, "AGENTS.md");
  const claudeMd = join(agentDir, "CLAUDE.md");
  if (!existsSync(agentsMd)) error("agents_md_missing", "AGENTS.md does not exist");
  if (!existsSync(claudeMd)) error("claude_md_missing", "CLAUDE.md does not exist");
  if (existsSync(agentsMd) && existsSync(claudeMd) && readFileSync(agentsMd, "utf8") !== readFileSync(claudeMd, "utf8")) {
    error("agents_md_diverges", "AGENTS.md and CLAUDE.md differ");
  }
  if (loaded.resolvePath(manifest.agents_md) !== agentsMd) error("manifest_agents_md", `agent.yaml agents_md must point at ./AGENTS.md`);

  // Directories and the eval config.
  for (const [field, rel] of [["scenarios", manifest.scenarios], ["evals", manifest.evals]] as const) {
    if (!existsSync(loaded.resolvePath(rel))) error(`${field}_missing`, `${rel} does not exist`);
  }
  const evalPath = join(loaded.resolvePath(manifest.evals), "eval.yaml");
  if (!existsSync(evalPath)) error("eval_missing", "evals/eval.yaml does not exist");
  else {
    const evalDoc = parseYaml(readFileSync(evalPath, "utf8")) as Record<string, unknown> | null;
    if (evalDoc?.["extends"] !== "../agent.yaml") error("eval_extends", 'evals/eval.yaml must start with `extends: ../agent.yaml`');
    for (const key of Object.keys(evalDoc ?? {})) {
      if (key !== "extends" && key in ManifestSchema.innerType().shape) error("eval_redeclares_manifest", `evals/eval.yaml redeclares \`${key}\`; only cases and metrics belong there`);
    }
  }

  // Wording the docs must not carry UNQUALIFIED (section 6).
  //
  // Until ent#1633 the phrase was forbidden outright, because nothing in the
  // product supported it. A receipt sealed since then carries an Ed25519
  // signature over `codespar-receipt:v1:<id>:<chain>` that anybody can check
  // against the published key set, so the claim is now true — of that, and of
  // nothing else here. Every receipt sealed BEFORE the change carries no such
  // signature and never will, and the approval artifact is still HMAC with a
  // local development key.
  //
  // So the rule is no longer "never write it". It is two conditions, and an
  // agent has to meet both. The agent must actually MINT a receipt that
  // carries the seal — only a payment does, and `maturity` is where the agent
  // says so — and the doc must NAME the mechanism, which is the word that
  // tells a reader which of the two claims is being made.
  const verificationMaturity = manifest.maturity["receipt-verification"];
  const sealsVerifiableReceipts = hasPayment && verificationMaturity !== undefined && verificationMaturity !== "blocked";
  for (const file of ["README.md", "runbook.md", "SYSTEM_PROMPT.md"]) {
    const path = join(agentDir, file);
    if (!existsSync(path)) {
      if (file !== "SYSTEM_PROMPT.md") error("doc_missing", `${file} does not exist`);
      continue;
    }
    const text = readFileSync(path, "utf8").toLowerCase();
    const claims = text.includes("verificável por terceiro") || text.includes("verifiable by a third party") || text.includes("third-party verifiable");
    if (!claims) continue;
    if (!sealsVerifiableReceipts) {
      error("doc_overclaims", `${file} claims third-party verifiability, and this agent seals nothing that carries it: only a payment receipt gets an Ed25519 signature, and agent.yaml declares receipt-verification as \`${verificationMaturity ?? "absent"}\``);
    } else if (!text.includes("ed25519")) {
      error("doc_overclaims", `${file} claims third-party verifiability without naming Ed25519; the receipt's asymmetric seal is the only thing here a third party can check, and receipts sealed before it — and the approval artifact — are HMAC`);
    }
  }

  const envExample = join(agentDir, ".env.example");
  if (!existsSync(envExample)) error("env_example_missing", ".env.example does not exist");
  else {
    const keys = readFileSync(envExample, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=")[0]);
    const extra = keys.filter((k) => k !== "CODESPAR_API_KEY" && k !== "ANTHROPIC_API_KEY");
    if (extra.length) error("env_example_extra", `.env.example declares more than the two keys: ${extra.join(", ")}`);
    if (!keys.includes("CODESPAR_API_KEY") || !keys.includes("ANTHROPIC_API_KEY")) error("env_example_incomplete", ".env.example must declare CODESPAR_API_KEY and ANTHROPIC_API_KEY");
  }

  // `receipt-verification` used to be a warning at `live`, because Ed25519 did
  // not exist. It does (ent#1633), so what is left to check is the coherence
  // the other maturity rules check: only a PAYMENT seals a receipt. A paid
  // charge is reported by the API with no chain and no signature, so an agent
  // that issues receivables and declares this capability beyond `blocked` is
  // claiming a verification its records cannot carry.
  if (verificationMaturity !== undefined && verificationMaturity !== "blocked" && !hasPayment) {
    error("maturity_overclaims", "agent.yaml declares receipt-verification beyond `blocked` and tools.json has no payment meta-tool; only a payment seals a receipt, and a paid charge carries no signature to verify");
  }

  return { ok: findings.every((f) => f.level !== "error"), agent: manifest.name, findings };
}
