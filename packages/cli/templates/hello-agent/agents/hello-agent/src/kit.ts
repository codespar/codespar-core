/**
 * The whole of this agent's code. It reads and proposes nothing, so it keeps
 * the shared defaults and replaces two things: the tool it offers, and the
 * webhook-replay case, which drives the core directly.
 */
import { defaultKit, defineAgent } from "@codespar/agent-runtime";
import type { StubRail } from "@codespar/agent-core";
import { listBills } from "./bills.js";

export const agent = defineAgent(import.meta.url, {
  ...defaultKit,
  labels: { ...defaultKit.labels, intro: 'Pergunte sobre as contas do mes ("quais contas vencem em outubro?"). Ctrl+D ou "sair" encerra.' },
  handlers: () => ({ list_bills: listBills }),

  /** The same `commerce.payment.succeeded` twice, and `paid` before `created`: one settled, never two. */
  runEventsCase: async (s) => {
    const draft = await s.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!draft.ok) throw new Error("refused");
    let execution = draft.execution;
    if (execution.state === "awaiting_approval") execution = s.engine.approve(execution.id, { id: "usr_demo_titular", channel: "terminal" });
    (s.rail as StubRail).armUncertainOnce();
    execution = await s.engine.execute(execution.id);
    const attempt = `att_${execution.idempotency_key.slice(4)}_0`;
    for (const [event_id, type] of [
      ["evt_paid_1", "commerce.payment.succeeded"],
      ["evt_paid_1", "commerce.payment.succeeded"],
      ["evt_created_late", "commerce.payment.created"],
      ["evt_paid_2", "commerce.payment.succeeded"],
    ] as const) {
      s.engine.ingestExternalEvent({ event_id, type, attempt_id: attempt });
    }
  },
});
