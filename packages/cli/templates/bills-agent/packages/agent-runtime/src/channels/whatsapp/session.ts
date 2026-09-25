/**
 * WhatsApp's own rule, which is not ours and which the simulator obeys
 * anyway: outside the 24 hours that follow the person's last message, a
 * business may only send a TEMPLATE that Meta approved in advance. Inside
 * the window it may write freely.
 *
 * The simulator enforces it for the reason a simulator exists: something that
 * only fails against the real provider is something you discover in
 * production. A collections agent hits this constantly — the debtor answers
 * on Tuesday, the charge is paid on Friday, and "recebemos, acordo quitado"
 * falls outside the window.
 *
 * Template APPROVAL is a STUB and cannot be anything else from here: a
 * template is registered in a Meta Business account, reviewed by Meta, and
 * given a status we have no way to read without that account. What this holds
 * is the LOCAL registry — the templates the agent declares it uses, from
 * `channels/whatsapp/templates.json` — so sending one that was never declared
 * is refused here instead of 400-ing at Meta. Whether Meta approved it is the
 * developer's to check, and the README says so.
 */
import { templateArity, type WhatsAppTemplate } from "@codespar/agent-core";

export const SESSION_WINDOW_SECONDS = 24 * 60 * 60;

export interface SessionState {
  /** Unix seconds of the last message the PERSON sent, on the provider's clock. */
  lastInboundAt?: number | undefined;
}

/** Why a template send would be refused. `undefined` means it may go. */
export type TemplateRefusal = { rule: string; detail: string } | undefined;

export class SessionWindow {
  private readonly templates: Map<string, WhatsAppTemplate>;
  private lastInboundAt: number | undefined;

  constructor(templates: readonly WhatsAppTemplate[], initial?: SessionState) {
    this.templates = new Map(templates.map((t) => [t.name, t]));
    this.lastInboundAt = initial?.lastInboundAt;
  }

  observeInbound(timestamp: number): void {
    if (this.lastInboundAt === undefined || timestamp > this.lastInboundAt) this.lastInboundAt = timestamp;
  }

  /** Seconds left before free-form messages stop being allowed; 0 when the window is shut or was never opened. */
  remainingSeconds(now: Date): number {
    if (this.lastInboundAt === undefined) return 0;
    return Math.max(0, this.lastInboundAt + SESSION_WINDOW_SECONDS - Math.floor(now.getTime() / 1000));
  }

  open(now: Date): boolean {
    return this.remainingSeconds(now) > 0;
  }

  /** The declaration, for a caller that has to build a send: the language is the registry's, never the caller's guess. */
  declared(name: string): WhatsAppTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * What the Cloud API would refuse about this template send, decided against
   * the declaration. Three things are visible to a registry: a name nobody
   * declared, a language the template was not registered in, and a variable
   * count the body has no placeholders for. Meta answers each with a 4xx and
   * delivers nothing, so each is refused here instead.
   */
  refuse(body: { template: string; language: string; variables: readonly string[] }): TemplateRefusal {
    const declared = this.templates.get(body.template);
    if (!declared) {
      return {
        rule: "template_unknown",
        detail: `the agent declares no template named ${body.template}; Meta only delivers templates it approved, and this one was never registered here`,
      };
    }
    if (declared.language !== body.language) {
      return {
        rule: "template_language_unknown",
        detail: `${body.template} is declared in ${declared.language}, not ${body.language}; a template approved in one language does not exist in another`,
      };
    }
    const expected = templateArity(declared.body);
    if (body.variables.length !== expected) {
      return { rule: "template_variables_mismatch", detail: `${body.template} takes ${expected} variable(s) and this send carries ${body.variables.length}` };
    }
    return undefined;
  }
}

/**
 * Where a conversation's window stood, read back from a bundle's
 * `channel.jsonl`. This is what lets a later process — a poll, days after the
 * run that opened the conversation — know whether it may still write freely,
 * instead of assuming the worst and always sending a template.
 *
 * It reads the PROVIDER's timestamp and never the line's `at`, which is the
 * run's own clock: the 24 hours are counted by WhatsApp on WhatsApp's clock,
 * and a record written by a machine whose clock drifted is not evidence about
 * theirs. A log carrying no provider timestamp on any inbound line yields no
 * state, and the window then reads as SHUT — the safe direction, because a
 * template is deliverable in both halves of the rule and a free-form message
 * is deliverable in one.
 */
export function sessionStateFromChannelLog(lines: ReadonlyArray<Record<string, unknown>>): SessionState {
  let lastInboundAt: number | undefined;
  for (const line of lines) {
    if (line["direction"] !== "in") continue;
    const at = line["provider_timestamp"];
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (lastInboundAt === undefined || at > lastInboundAt) lastInboundAt = at;
  }
  return { lastInboundAt };
}
