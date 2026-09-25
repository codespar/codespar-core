/**
 * Which channels the runner can open, and how one is opened for an agent.
 *
 * The runner owns channels; an agent owns the CONVERSATIONS it ships for one
 * (`channels/whatsapp/*.json`). That is the split `npm run check` enforces in
 * both directions: declare a channel and ship no conversation for it and the
 * manifest gate fails; ship one and declare nothing and it fails too.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseConversationScript, parseTemplateRegistry, TEMPLATE_REGISTRY_FILE, type ChannelName, type ConversationScript, type WhatsAppTemplate } from "@codespar/agent-core";
import type { Agent } from "../agent.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./whatsapp/index.js";
export * from "./whatsapp/run.js";

export function conversationsDir(agent: Agent): string {
  return join(agent.dir, "channels", "whatsapp");
}

export function listConversations(agent: Agent): string[] {
  const dir = conversationsDir(agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== TEMPLATE_REGISTRY_FILE)
    .map((f) => basename(f, ".json"))
    .sort();
}

/**
 * The templates this agent declares, or none. An agent that never speaks
 * outside the session window ships no registry and the channel then refuses
 * every template, which is the honest answer: a template nobody declared is
 * one Meta was never asked to approve.
 */
export function loadTemplates(agent: Agent): WhatsAppTemplate[] {
  const path = join(conversationsDir(agent), TEMPLATE_REGISTRY_FILE);
  if (!existsSync(path)) return [];
  return parseTemplateRegistry(readFileSync(path, "utf8")).templates;
}

export function loadConversation(agent: Agent, name: string): ConversationScript {
  const path = join(conversationsDir(agent), `${name}.json`);
  if (!existsSync(path)) throw new Error(`unknown conversation ${name}; available: ${listConversations(agent).join(", ") || "none"}`);
  return parseConversationScript(readFileSync(path, "utf8"));
}

/**
 * The conversation a run binds to: the one named, or the only one the agent
 * ships. An agent with several and no `--conversation` is asked rather than
 * guessed for — which debtor a message goes to is not a default.
 */
export function resolveConversation(agent: Agent, name: string | undefined): ConversationScript {
  const available = listConversations(agent);
  if (name) return loadConversation(agent, name);
  if (available.length === 1) return loadConversation(agent, available[0]!);
  if (available.length === 0) throw new Error(`${agent.slug} ships no conversation under channels/whatsapp/`);
  throw new Error(`--conversation is required: ${agent.slug} ships ${available.join(", ")}`);
}

/** Every subject the agent has a conversation for, so "names another agreement" is decidable. */
export function knownSubjects(agent: Agent): string[] {
  return listConversations(agent)
    .map((name) => loadConversation(agent, name).subject)
    .filter((s): s is string => typeof s === "string");
}

export function isChannelName(value: string): value is ChannelName {
  return value === "terminal" || value === "whatsapp";
}
