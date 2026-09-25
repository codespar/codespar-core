/**
 * The channels an agent can be reached on, and the one artifact an agent
 * ships per channel.
 *
 * The NAMES live here because `agent.yaml` declares them and `npm run check`
 * has to confirm the declaration against what the agent ships; the BEHAVIOUR
 * lives in `@codespar/agent-runtime`, which owns the runner. That split is
 * the same one `tools.json` and `guardrails.json` already have: the core
 * owns the shape, the runtime owns what happens.
 *
 * `terminal` is every agent's: `npm start` opens it and needs no account.
 * `whatsapp` is the second channel, and an agent that declares it ships the
 * conversations the local Cloud API emulator drives, under
 * `channels/whatsapp/`.
 */
import { z } from "zod";

export const CHANNELS = ["terminal", "whatsapp"] as const;
export type ChannelName = (typeof CHANNELS)[number];

/** E.164, the only contact shape WhatsApp addresses. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * A scripted conversation, which is what an agent ships for a channel whose
 * other side is a person rather than a keyboard.
 *
 * It exists for two readers. A local emulator of the Cloud API drives it with
 * no Meta account, which is what makes the WhatsApp gate runnable in the CI;
 * and `npm run check` parses it, so a conversation that no longer names a
 * contact or an agreement fails the manifest gate instead of failing a run.
 *
 * It scripts ONE side. What the agent answers comes from the model or from a
 * recorded transcript, never from here, for the same reason a scenario pack
 * asserts a final state and not a wording.
 */
export const ConversationScriptSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(1),
    channel: z.literal("whatsapp"),
    /** The contact the conversation is bound to: the person who owes, and nobody else. */
    contact: z.string().regex(E164, "contact must be E.164, e.g. +5511987654321"),
    /**
     * What this conversation is allowed to be about — an agreement alias for a
     * collections agent. The channel refuses an outbound message that names a
     * different one, which is the secrecy rule as code rather than as prose.
     */
    subject: z.string().min(1).optional(),
    /** The person's turns, in order. */
    turns: z
      .array(
        z
          .object({
            text: z.string().min(1),
            /** Seconds after the previous inbound turn, on the run's clock. Keeps a scripted run deterministic. */
            after_seconds: z.number().int().nonnegative().default(0),
          })
          .strict(),
      )
      .nonempty(),
  })
  .strict();

export type ConversationScript = z.infer<typeof ConversationScriptSchema>;

export function parseConversationScript(text: string): ConversationScript {
  return ConversationScriptSchema.parse(JSON.parse(text));
}

/**
 * The reserved file name inside `channels/whatsapp/`: the template registry,
 * which is not a conversation. Everything else in that directory is one, so
 * a conversation may not be called `templates`.
 */
export const TEMPLATE_REGISTRY_FILE = "templates.json";

/**
 * One template the agent declares it sends.
 *
 * `body` is here for a reader, not for a sender: it is the text AS SUBMITTED
 * to Meta, and it is the only way somebody opening this repository can tell
 * what `{{1}}` means. Nothing composes a message from it — Meta holds the
 * approved copy and renders it — but the number of placeholders in it IS
 * checked against the variables a send carries, because a count that does not
 * match is a `132000` from the Cloud API and there is no reason to learn that
 * in production.
 */
export const WhatsAppTemplateSchema = z
  .object({
    /** Meta's own naming rule for a template. */
    name: z.string().regex(/^[a-z0-9_]+$/, "a template name is lower-case letters, digits and underscores"),
    /** Meta's language code, e.g. `pt_BR`. A template approved in one language does not exist in another. */
    language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'expected a language code, e.g. "pt_BR"'),
    description: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();

export type WhatsAppTemplate = z.infer<typeof WhatsAppTemplateSchema>;

/**
 * `channels/whatsapp/templates.json`: the LOCAL registry of the templates an
 * agent uses.
 *
 * Outside the 24 hours that follow the person's last message WhatsApp carries
 * an approved template and nothing else, so an agent that ever speaks after
 * that has to own one. Whether META approved it is NOT knowable from here —
 * it is a status inside a Business account, and this repository has none — so
 * what this file proves is narrower and worth stating exactly: the agent
 * declared the name, so a send of a name nobody declared is refused here
 * instead of 400-ing at Meta. Registering the template and getting it approved
 * stays the developer's, and the README says so.
 */
export const TemplateRegistrySchema = z
  .object({
    channel: z.literal("whatsapp"),
    templates: z.array(WhatsAppTemplateSchema).nonempty(),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const seen = new Set<string>();
    for (const [i, template] of registry.templates.entries()) {
      if (seen.has(template.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["templates", i, "name"], message: `${template.name} is declared twice` });
      seen.add(template.name);
    }
  });

export type TemplateRegistry = z.infer<typeof TemplateRegistrySchema>;

export function parseTemplateRegistry(text: string): TemplateRegistry {
  return TemplateRegistrySchema.parse(JSON.parse(text));
}

/** The highest `{{n}}` in a template body, which is how many variables a send of it must carry. */
export function templateArity(body: string): number {
  let highest = 0;
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) highest = Math.max(highest, Number(match[1]));
  return highest;
}
