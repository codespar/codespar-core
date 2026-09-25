/**
 * The rules of collecting over a conversation, as code.
 *
 * The spec names four (section 16): the hours, the secrecy of the debt, no
 * embarrassment, LGPD. Two of those are decidable by a machine and are
 * enforced here, on EVERY outbound message, above the backend — so choosing
 * the simulator or the official API changes nothing about what may be said.
 * The other two are the prompt's and the operator's: no code can read a
 * sentence and tell whether it shames somebody.
 *
 *   hours          nothing is sent outside the collection window. The
 *                  envelope already refuses to DRAFT a receivable outside
 *                  it; this refuses to SPEAK outside it, which is the rule
 *                  the law actually states.
 *   bound contact  a message goes to the person the conversation is bound to
 *                  and to no other number. This is the secrecy rule: the way
 *                  a debt reaches a third party is by being sent to one.
 *   subject        a message may not name an agreement other than this
 *                  conversation's. Same rule, other direction: the debtor
 *                  learning about somebody else's debt.
 *   no document    a CPF or a CNPJ never appears in a message. The prompt
 *                  says so; this makes it true even if the model ignores it.
 *
 * Every rule can only REFUSE. None of them rewrites a message: a message
 * that is edited on the way out is not the message the transcript shows.
 */
import { isOutsideHours, localClock } from "@codespar/agent-core";
import type { Conversation, OutboundBody } from "./types.js";

export interface ChannelRefusal {
  rule: string;
  detail: string;
}

export interface HoursRule {
  /** The OPEN window, `HH:MM-HH:MM`, as `guardrails.envelope.collection_hours` spells it. */
  window: string;
  timezone: string;
}

export interface RuleContext {
  conversation: Conversation;
  hours?: HoursRule | undefined;
  now: () => Date;
  /** Agreement aliases this agent knows, so "names another agreement" is decidable. */
  knownSubjects?: readonly string[] | undefined;
}

/** `123.456.789-00`, `12345678900`, `12.345.678/0001-95`, `12345678000195`. */
const FORMATTED_DOCUMENT = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/;

/**
 * A bare document is a token of exactly 11 or 14 digits. Token-wise and not
 * substring-wise on purpose: a Pix BR Code is one token of 100+ characters
 * and a substring rule would find a "CPF" inside every payable message.
 */
function hasBareDocument(text: string): boolean {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^0-9]+|[^0-9]+$/g, ""))
    .some((t) => /^\d{11}$/.test(t) || /^\d{14}$/.test(t));
}

/** The prose a rule reads. The rail's own strings are not prose and are not read. */
export function proseOf(body: OutboundBody): string[] {
  switch (body.kind) {
    case "text":
      return [body.text];
    case "media":
      return body.caption === undefined ? [] : [body.caption];
    case "template":
      return body.variables;
    case "instrument":
      return [];
  }
}

/** `undefined` when the message may go out. The first refusal wins, so the reason is stable. */
export function checkOutbound(to: string, body: OutboundBody, ctx: RuleContext): ChannelRefusal | undefined {
  if (to !== ctx.conversation.contact) {
    return {
      rule: "bound_contact",
      detail: "a collection message goes to the person who owes and to nobody else; this conversation is bound to another contact",
    };
  }

  if (ctx.hours) {
    const [open, close] = ctx.hours.window.split("-") as [string, string];
    // The envelope states the OPEN window; `isOutsideHours` reads a CLOSED one, so it is inverted here the same way the envelope policy inverts it.
    if (isOutsideHours(`${close}-${open}`, ctx.now(), ctx.hours.timezone)) {
      return {
        rule: "collection_hours",
        detail: `fora do horario de cobranca (${ctx.hours.window} ${ctx.hours.timezone}); agora sao ${localClock(ctx.now(), ctx.hours.timezone)}`,
      };
    }
  }

  const prose = proseOf(body);

  for (const text of prose) {
    if (FORMATTED_DOCUMENT.test(text) || hasBareDocument(text)) {
      return { rule: "no_document", detail: "a message must not carry a CPF or a CNPJ; the code takes the document from the agreement and never speaks it" };
    }
  }

  const subject = ctx.conversation.subject;
  if (subject && ctx.knownSubjects?.length) {
    for (const text of prose) {
      const lowered = text.toLowerCase();
      const other = ctx.knownSubjects.find((s) => s !== subject && lowered.includes(s.toLowerCase()));
      if (other) {
        return { rule: "subject_scope", detail: `this conversation is about ${subject}; a message here may not name ${other}` };
      }
    }
  }

  if (body.kind === "text" && body.text.trim() === "") return { rule: "empty_message", detail: "an empty message is not a message" };

  return undefined;
}
