/**
 * Everything about this agent the shared runner cannot know: the cart the
 * conversation builds (in state.db), the price and discount envelope the core
 * runs as its `policyExtension`, the bolepix rail and its sandbox payer, the
 * tool handlers, the words the customer and the attendant read, and what a
 * one-shot prints as JSON. The runner (`@codespar/agent-runtime`) owns the
 * rest.
 *
 * Ordering and issuing are two moments (`executeOnApproval: false`): the
 * attendant, or the policy, confirms the order, and the charge goes out when
 * the customer asks for it, through the last gate.
 *
 * There is no consent step: the sales policy is the MERCHANT's own and no API
 * surface signs it (checkout §3.3), so the example file is the policy in both
 * rails.
 */
import { relative } from "node:path";
import qrcode from "qrcode-terminal";
import {
  CodeSparChargeRail,
  NotATestKeyError,
  StubChargeRail,
  createCodeSparClient,
  isTestKey,
  loadMandate,
  paySandboxCharge,
  type Execution,
  type StubChargeRailOptions,
} from "@codespar/agent-core";
import { defineAgent, envName, type AgentKit, type Setup } from "@codespar/agent-runtime";
import { formatBRL, formatDate } from "./catalog.js";
import { checkOrder, loadEnvelope, priceCart, localDate } from "./pricing.js";
import { claimOrder, CartBook, makeCartHandlers, type Cart } from "./modules/storefront-cart.js";
import { followCart, makeChargeHandlers, orderProposal } from "./modules/bolepix-receivables.js";
import { CodeSparInvoiceRail, followSale, InvoiceBook, resumeInvoices, StubInvoiceRail, type InvoiceDeps, type InvoiceRail, type StubIssuerBehaviour } from "./modules/nfse-invoice.js";

function cartOf(setup: Setup, execution: Execution): Cart | undefined {
  return execution.composition ? new CartBook(setup.store).get(execution.composition.ref) : undefined;
}

const invoiceRails = new WeakMap<Setup, InvoiceRail>();

/**
 * The issuer the NFS-e goes to: `codespar_invoice` through the API with a
 * test key, the stub issuer otherwise. `CHECKOUT_STUB_ISSUER` scripts the
 * stub from a test process (issues | refuses | times_out | unsent_once | unsent).
 */
function invoiceRail(s: Setup): InvoiceRail {
  let rail = invoiceRails.get(s);
  if (!rail) {
    const scripted = process.env[envName(s.agent, "STUB_ISSUER")] as StubIssuerBehaviour | undefined;
    rail = s.api ? new CodeSparInvoiceRail(s.api) : new StubInvoiceRail(s.store, scripted);
    invoiceRails.set(s, rail);
  }
  return rail;
}

function invoiceDeps(s: Setup, say: (line: string) => void): InvoiceDeps {
  const carts = new CartBook(s.store);
  return { store: s.store, engine: s.engine, rail: invoiceRail(s), cart: (ref) => carts.get(ref), say };
}

/**
 * A cart and its order placed outside a conversation: the velocity window's
 * history (`warmUp`) and the webhook case. Same book, same proposal, same
 * gates as a conversation's.
 */
async function placeOrder(s: Setup, customer: string, lines: Array<{ sku: string; quantity: number }>): Promise<Execution> {
  const book = new CartBook(s.store);
  const now = s.engine.clock();
  const priced = priceCart({ lines }, loadEnvelope(s.guardrails), localDate(now, s.guardrails.timezone));
  const runId = s.runId;
  const cartId = book.nextId(runId);
  const cart: Cart = { ...priced, cart_id: cartId, ref: `${runId}/${cartId}`, run_id: runId, version: 1, currency: "BRL", order_discount_pct: 0, updated_at: now.toISOString() };
  book.save(cart);
  const draft = await s.engine.draft(orderProposal(cart, customer, { timezone: s.guardrails.timezone, clock: s.engine.clock }));
  if (!draft.ok) throw new Error(`refused: ${draft.reason}`);
  claimOrder(s.engine, cart, draft.execution.id);
  return draft.execution;
}

const kit: AgentKit = {
  settlement: "await-payer",
  scenarioRail: "requested",
  executeOnApproval: false,

  labels: {
    defaultUser: "usr_atendente",
    evalUser: "usr_atendente",
    mandateWord: "politica",
    receiptWord: "pedido",
    intro: 'Voce e o cliente. Diga o que quer ("oi, sou a Marina, quero o pacote de dez aulas e uma avaliacao inicial"). Ctrl+D ou "sair" encerra.',
    prompt: "cliente> ",
    approveQuestion: "  [atendente] Confirmar este pedido? [s/N] ",
    uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita a emissao)",
    missingReceiptKind: "record_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `paid charge ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing (${e.reason}) — ${e.detail}; nothing was re-issued; \`npm run poll\` keeps looking`,
    waitingForPayer: (round) => `  aguardando o pagamento... (${round} consultas)`,
  },

  usage: () => `checkout-agent
  npm start                                                        interactive terminal (you are the customer; the attendant answers the approval question)
  npm start -- --input "oi, sou a Marina, quero o pacote de dez aulas e uma avaliacao inicial"   one turn (add --approve/--deny, --json)
  npm start -- --scenario <name>                                   run a scenario pack (see scenarios/)
  npm run approve -- <execution-id>                                the attendant confirms an order left awaiting (it is issued when the customer asks)
  npm start -- --channel whatsapp --conversation <name>            the conversation channel (needs npm run whatsapp:emulator at the repo root)
  npm start -- --channel whatsapp --conversation <name> --scripted the same, with the customer's turns replayed from channels/whatsapp/
  npm run poll -- --channel whatsapp --conversation <name>         back to a conversation whose payment landed after the run ended
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>
         --wait <seconds>  --simulate-payer  --payer pays|expires|never (stub only)  --json
         --now <ISO 8601>  pin the run to that instant (service hours, the due date, timestamps); env CODESPAR_AGENT_NOW is the same thing`,

  buildRail: (ctx) => {
    const mandate = ctx.mandate ?? loadMandate(ctx.manifest.resolvePath(ctx.manifest.manifest.mandate_schema));
    if (ctx.kind === "api") {
      if (!isTestKey(ctx.env["CODESPAR_API_KEY"])) throw new NotATestKeyError();
      const client = createCodeSparClient({ apiKey: ctx.env["CODESPAR_API_KEY"], baseUrl: ctx.env["CODESPAR_API_URL"], projectId: ctx.env["CODESPAR_PROJECT_ID"] });
      return {
        rail: new CodeSparChargeRail(client),
        mandate,
        api: client,
        pollIntervalMs: 3000,
        payer: {
          kind: "api" as const,
          async pay(chargeId: string) {
            const result = await paySandboxCharge(client, chargeId);
            if (!result.ok) return { ok: false as const, detail: `${result.failure.code}: ${result.failure.message}` };
            const s = result.state;
            return { ok: true as const, detail: `sandbox payer: ${s.charge_id} ${s.status} (${s.payment}, ${s.paid_minor} of ${s.quoted_minor}), simulated=${s.simulated}, settled_against=${s.settled_against}, money_moved=${s.money_moved}${s.idempotent_replay ? ", replay" : ""}` };
          },
          behave() {
            /* the API's payer is a route, not a fixture; a scenario that needs "expires" declares rails: [stub] */
          },
        },
      };
    }
    // CHECKOUT_KILL_AFTER_DISPATCH=1 simulates a crash right after the issuer accepted the charge and before the outcome was recorded.
    const killAfterDispatch = ctx.envVar("KILL_AFTER_DISPATCH") === "1" ? { afterDispatch: () => process.exit(137) } : {};
    // CHECKOUT_STUB_PAYER=pays|expires|never: what the fixture payer does, from a test process.
    const behaviour = ctx.envVar("STUB_PAYER");
    const fixture: Pick<StubChargeRailOptions, "payer"> = behaviour === "pays" || behaviour === "expires" || behaviour === "never" ? { payer: behaviour } : {};
    const stub = new StubChargeRail(ctx.store, { ...(ctx.now ? { clock: ctx.now } : {}), ...killAfterDispatch, ...fixture, ...(ctx.stubRail ?? {}) });
    return {
      rail: stub,
      mandate,
      pollIntervalMs: 0,
      payer: {
        kind: "stub" as const,
        async pay(_chargeId: string, attemptId: string) {
          stub.decide(attemptId, "pays");
          return { ok: true as const, detail: "stub payer: will pay at the next look" };
        },
        behave: (b) => stub.setPayer(b),
        decideFor: (attemptId, b) => stub.decide(attemptId, b),
      },
    };
  },

  handlers: (setup) => {
    const envelope = loadEnvelope(setup.guardrails);
    const book = new CartBook(setup.store);
    // On a channel that binds a conversation, the customer is the one it is bound to: read at call time, because the channel binds after setup.
    const orderDeps = { book, runId: setup.runId, timezone: setup.guardrails.timezone, clock: setup.engine.clock, boundCustomer: () => setup.conversation?.subject };
    return {
      ...makeCartHandlers({ ...orderDeps, envelope, onReplaced: (cart, engine) => void followCart(cart, engine, orderDeps) }),
      ...makeChargeHandlers(orderDeps),
    };
  },

  policyExtension: ({ guardrails, store }) => {
    const envelope = loadEnvelope(guardrails);
    const book = new CartBook(store);
    return (execution, ctx) => checkOrder(execution, execution.composition ? book.get(execution.composition.ref) : undefined, envelope, ctx.now, ctx.guardrails.timezone);
  },

  describeExecution: (execution, setup) => {
    const lines: string[] = [];
    const cart = cartOf(setup, execution);
    lines.push(`  pedido ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
    lines.push(`    cliente ${execution.items[0]?.beneficiary ?? "?"}${cart ? `, carrinho ${cart.cart_id} v${cart.version}` : ""}`);
    for (const l of cart?.line_items ?? []) lines.push(`    - ${l.quantity}x ${l.name}: ${formatBRL(l.totals.find((t) => t.type === "total")!.amount)}${l.discount_pct ? ` (desconto ${l.discount_pct}%)` : ""}`);
    for (const d of cart?.order_discounts ?? []) lines.push(`    - ${d.kind === "coupon" ? `cupom ${d.ref.replace("coupon:", "")}` : "desconto no pedido"}: ${formatBRL(-d.amount)}`);
    lines.push(`    total (calculado pelo core): ${formatBRL(execution.total)}${execution.items[0]?.due_date ? `, vence ${formatDate(execution.items[0].due_date)}` : ""}`);
    if (execution.composition) lines.push(`    cart_hash ${execution.composition.composition_hash.slice(0, 19)}… (${execution.composition.line_count} linha(s))`);
    if (execution.escalation) lines.push(`    escalado por: ${execution.escalation.trigger} — ${execution.escalation.detail}`);
    if (execution.blocking_reasons.length) lines.push(`    bloqueado: ${execution.blocking_reasons.join(", ")} — a politica nao autoriza; nao ha o que aprovar`);
    if (execution.detail && execution.state !== "awaiting_approval") lines.push(`    ${execution.detail}`);
    for (const outcome of execution.outcomes) {
      if (outcome.transaction_id) lines.push(`    cobranca: ${outcome.transaction_id} — ${outcome.status}${outcome.code ? ` (${outcome.code})` : ""}`);
      if (outcome.receipt_id) lines.push(`    pedido pago: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
    }
    const invoice = new InvoiceBook(setup.store).of(execution.id);
    if (invoice) lines.push(`    NFS-e ${invoice.id}: ${invoice.state}${invoice.reason ? ` (${invoice.reason}, ${invoice.code})` : ""}${invoice.document ? ` — documento ${invoice.document.id}` : ""}`);
    return lines;
  },

  oneShotPayload: ({ setup: s, reply, toolCalls, executions, startedAt }) => {
    const book = new CartBook(s.store);
    return {
      run_id: s.runId,
      agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
      mode: s.mode,
      rail: s.railKind,
      policy_id: s.mandate.id,
      actor: s.engine.agentActor,
      reply,
      tool_calls: toolCalls,
      carts: book.idsOf(s.runId).map((id) => book.byId(s.runId, id)!).map((c) => ({ cart_id: c.cart_id, version: c.version, cart_hash: c.cart_hash, total_minor: c.total, validation_issues: c.validation_issues.map((i) => i.code) })),
      executions: executions.map((e) => {
        const cart = cartOf(s, e);
        const outcome = e.outcomes[0];
        return {
          id: e.id,
          state: e.state,
          reason: e.reason ?? null,
          escalation: e.escalation ?? null,
          cart_id: cart?.cart_id ?? null,
          cart_hash: e.composition?.composition_hash ?? null,
          total_minor: e.total,
          due_date: e.items[0]?.due_date ?? null,
          approval_id: e.approval_id ?? null,
          charge_id: outcome?.transaction_id ?? null,
          payable: outcome?.instrument?.payable ?? null,
          pix_copy_paste: outcome?.instrument?.pix_copy_paste ?? null,
          receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
        };
      }),
      invoices: executions.map((e) => new InvoiceBook(s.store).of(e.id)).filter((r) => r !== undefined).map((r) => ({ id: r.id, sale_execution_id: r.sale_execution_id, state: r.state, reason: r.reason ?? null, code: r.code ?? null, document_id: r.document?.id ?? null, attempts: r.attempts })),
      receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
      bundle_dir: relative(process.cwd(), s.bundle.dir),
      seconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
    };
  },

  /** What the customer reads when the charge is payable: the QR as an image, the copy-and-paste under it, the bank line if any. */
  presentInstrument: (execution, _instalment, chargeId, instrument, tell) => {
    tell("");
    tell(`Pedido de ${formatBRL(execution.total)}${instrument.due_date ? `, vence ${formatDate(instrument.due_date)}` : ""} — cobranca ${chargeId}`);
    if (instrument.pix_copy_paste) {
      qrcode.generate(instrument.pix_copy_paste, { small: true }, (qr: string) => {
        for (const line of qr.split("\n")) tell(line);
      });
      tell("Pix copia e cola:");
      tell(instrument.pix_copy_paste);
    }
    if (instrument.boleto_bank_line) {
      tell("Ou pelo boleto, linha digitavel:");
      tell(instrument.boleto_bank_line);
    }
    tell("");
  },

  /** One message per outcome, and only for an outcome: an order confirmed, or sent back to the attendant, is not one. */
  announceOutcome: (execution, setup, tell) => {
    if (!["settled", "failed", "denied", "expired"].includes(execution.state)) return false;
    if (!setup.engine.markTold(execution.id, execution.state)) return false;
    let text: string;
    if (execution.state === "settled") text = `Recebemos, pedido confirmado! Obrigado. (${execution.outcomes.map((o) => o.transaction_id).filter(Boolean).join(", ")})`;
    else if (execution.reason === "charge_expired") text = "A cobranca venceu sem pagamento. Se quiser, emito uma nova para o mesmo pedido.";
    else if (execution.reason === "charge_cancelled") text = "A cobranca foi cancelada. Nada foi pago.";
    else if (execution.reason === "charge_reference_ambiguous") text = "A cobranca deste pedido ja foi emitida e estamos conferindo a situacao dela. Nao pague de novo; te aviso assim que estiver conferida.";
    else if (execution.state === "failed") text = `Nao consegui emitir a cobranca (${execution.reason ?? "falha no trilho"}). Nada foi cobrado.`;
    else if (execution.state === "denied") text = `Nao consigo fechar o pedido nesses termos (${execution.reason ?? "recusado"}).`;
    else text = `O pedido expirou sem confirmacao (${execution.reason ?? execution.state}).`;
    tell(text);
    setup.engine.note("message.debtor", execution.id, { state: execution.state, reason: execution.reason ?? null, text });
    return true;
  },

  /** Checkout §4: a paid order opens its NFS-e, an execution of its own that never moves the sale. */
  followUp: async (execution, setup, say) => {
    await followSale(execution, invoiceDeps(setup, say));
  },
  resumeFollowUps: async (setup, say) => {
    for (const r of await resumeInvoices(invoiceDeps(setup, say))) say(`${r.id}: NFS-e of ${r.sale_execution_id} -> ${r.state}${r.reason ? ` (${r.reason}, ${r.code})` : ""}`);
  },

  /**
   * The same outcome as `announceOutcome`, as a template this agent declares
   * in `channels/whatsapp/templates.json`: what a poll sends once the 24-hour
   * window has shut, which for a sale is the ordinary case of a customer who
   * ordered at night and paid in the morning. A denial or an expired approval
   * is answered inside the turn that produced it, so it has no template, and
   * the poll reports it rather than sending approximate copy.
   */
  outcomeTemplate: (execution) => {
    const total = formatBRL(execution.total);
    if (execution.state === "settled") return { template: "pedido_confirmado", variables: [total] };
    if (execution.reason === "charge_expired") return { template: "pedido_cobranca_vencida", variables: [total] };
    if (execution.reason === "charge_cancelled") return { template: "pedido_cobranca_cancelada", variables: [total] };
    return undefined;
  },

  /** Orders already paid by the same customer under this policy, so the velocity window has history. */
  warmUp: async (s, aliases, approver) => {
    const warm = new Set<string>();
    for (const alias of aliases) {
      let e = await placeOrder(s, alias, [{ sku: "aula-avulsa", quantity: 1 }]);
      if (e.state === "awaiting_approval") e = s.engine.approve(e.id, approver);
      if (e.state === "approved") e = await s.engine.execute(e.id);
      for (let i = 0; i < 2 && e.state === "executing"; i += 1) e = await s.engine.reconcile(e.id);
      if (e.state !== "settled") throw new Error(`warm-up for ${alias} ended ${e.state} (${e.reason})`);
      warm.add(e.id);
    }
    return warm;
  },

  /** Webhook duplicated or out of order: the same `commerce.charge.paid` twice, `paid` before `created`, `expired` after `paid`. One settled, one message. */
  runEventsCase: async (s, tell) => {
    s.payer!.behave("never");
    let execution = await placeOrder(s, "marina", [{ sku: "aula-avulsa", quantity: 2 }]);
    if (execution.state === "awaiting_approval") execution = s.engine.approve(execution.id, { id: "usr_atendente", channel: "terminal" });
    execution = await s.engine.execute(execution.id);
    const chargeId = execution.outcomes[0]!.transaction_id!;
    const apply = (event_id: string, type: string) => {
      s.engine.ingestExternalEvent({ event_id, type, transaction_id: chargeId });
      kit.announceOutcome!(s.engine.get(execution.id)!, s, tell);
    };
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_created_late", "commerce.charge.created");
    apply("evt_paid_2", "commerce.charge.paid");
    apply("evt_expired_late", "commerce.charge.expired");
  },

  // The payer's behaviour is part of the recording: a charge that expired in the original run expires in the rerun.
  rerunPlan: (events) => {
    const expired = events.some((e) => e["type"] === "execution.transition" && (e["payload"] as { reason?: string }).reason === "charge_expired");
    return { stubRail: { payer: expired ? "expires" : "pays" }, simulatePayer: !expired };
  },
  rerunComparesOutcomes: false,

  evalScenarioLine: (check) =>
    `${check.ok ? "ok  " : "FAIL"} scenario/${check.run.scenario} [${check.mode}] — states ${JSON.stringify(check.run.executions.map((e) => e.state))}, ${check.run.charges_issued} charge(s), ${check.run.receipts} paid order(s), ${check.run.debtor_messages} message(s)${check.failures.length ? ` — ${check.failures.join("; ")}` : ""}`,
};

export const agent = defineAgent(import.meta.url, kit);
