# @codespar/agent-core

The primitives every CodeSpar starter-kit agent inherits (section 4 of spec v5.1.1, [`docs/spec-v5.1.1.md`](../../docs/spec-v5.1.1.md), the only spec version in this repository; [`docs/OPEN_QUESTIONS.md`](../../docs/OPEN_QUESTIONS.md) says where later parts were built against v5.2 and the checkout spec v0.2): the execution state machine, the approval artifact, the `agent.yaml` manifest, `escalate_above`, `actor`, local state in SQLite, the proof bundle, the rail contract, the conversation loop and the two providers.

This package is the decisions. The RUNNER around them — the terminal channel, `codespar-agent start|consent|approve|deny|resume|rerun|reconcile|poll|webhook|inspect|check|eval|verify`, the setup that wires this package to an agent directory, and the scenario and adversarial runners — is [`@codespar/agent-runtime`](../agent-runtime), which depends on this one and is what an agent's `package.json` scripts call (#13). Nothing here knows an agent's name.

## The state machine, and what the types do and do not prove

`transition(execution, to, input)` accepts only a `to` that the table in `state-machine.ts` lists for `execution.state`. On a **narrowed** value (`Execution<"drafted">`, `Execution<"executing">`, ...) a transition outside the table is a compile error, and `test/transitions.type-test.ts` keeps that true with `@ts-expect-error` lines that `tsc` refuses to leave unused. An **un-narrowed** `Execution` (the union, which is what a row read back from SQLite is) compiles for any target; the engine narrows with casts at its call sites. So the guard that always holds is the runtime one: `transition()` throws `IllegalTransitionError` on any pair the table does not list, whatever the static type said. The type test proves the table is closed; the runtime check enforces it.

## The one policy, three gates

`ExecutionEngine.policy()` runs at draft, at a human's approval and again immediately before `executing`, inside the transaction that writes the outbox row. Mandate status, allowlist, per-transaction cap, the window cap (counting settled, in flight AND awaiting executions as reservations), `escalate_above` and the artifact's `items_hash` are all re-checked at the last gate. A person's approval satisfies `escalate_above` and nothing else.

## What the artifact binds besides the items

`items_hash` covers the execution's items: payee, amount, currency and a receivable's due date. Two optional bindings cover what those fields cannot see, and each is **omitted, never null**, when it does not apply, so an artifact without them signs the same bytes it signed before they existed (`test/composition.test.ts` pins that against an artifact hashed on `main` before `composition` was added):

- `batch` — the set a line was approved inside (`batch_hash` over the ordered lines, the line's `index`, the `count`). One execution per line, N lines.
- `composition` — what ONE amount is made of (`{ ref, composition_hash, line_count }`, with `compositionHash` over the resolved lines). One execution, N lines behind it: a sale is one charge, so a cart of three lines is one item whose amount is the order's total. Two units at 100 and one unit at 200 are the same item and the same `items_hash`; they are not the same `composition_hash`. `compositionHash` uses `itemsHash`'s canonicalisation over `ref`, `quantity`, `unit_amount`, `amount` and `currency`, not `itemsHash` itself, because ten units at a 10% discount and nine at list price have the same line amount.

`checkApprovalArtifact` compares both, and the last gate sends a mismatch back to `awaiting_approval` with `items_hash_mismatch`, like a changed list. `ExecutionEngine.restate()` is how an OPEN execution (`awaiting_approval`, `approved`) follows the proposal behind it — a customer who changes the cart after the order was approved — without a transition: items, total, `items_hash` and composition are replaced, the state, the artifact and the idempotency key are kept, and the last gate does the refusing. The payees of a restatement cannot change.

## What of the artifact reaches the receipt

Every spend carries `approval: { items_hash, batch_hash? }`, the artifact's own hashes (`spendApprovalOf`), and the API seals them into the receipt's chain as a link of their own (chain v4, ent#1670). Both rails refuse a spend without them before any call. `composition` is not sent: the API takes the two hashes and nothing else, and only charges carry a composition today. `receipt-chain.ts` recomputes a chain from the receipt read under the `chain_recipe` the key document publishes (RFC 8785 implemented locally, `node:crypto` only), and `verifyReceiptRead` holds the signature, the body and the sealed approval link against the artifact, in that order. It proves WHAT was approved to anybody holding the read; WHO approved stays in the artifact, under the local key. `docs/OPEN_QUESTIONS.md` §3 and §47.

## Who acted, on the wire

Every spend sends the kit's actor as the SDK's `PaymentActor` (`wireActorOf` in `rail.ts`): an agent is `{ type: "agent", id: "<name>@<version>", on_behalf_of: <the mandate's consumer> }`, a person `{ type: "human", id, channel }`. `agent_id` still goes too; it names the agent the mandate was signed for. The rail reads the actor the API recorded back as `sealed_actor`, the bundle's receipt copy keeps it beside the kit's own `actor`, and one that differs from what was sent, or is missing, is a `receipt.actor_mismatch` event. It does not stop the run: the actor is what the receipt records, not what it proves. It is not in the chain, so a third party checking the Ed25519 signature learns nothing about who triggered the spend, and a charge carries no actor at all. §2.

## A settlement this run did not make

A spend presented again under the same attempt id is answered with the earlier payment (`idempotent_replay`). Dispatch marks that outcome `replayed: true`, and `isReplayedSettlement(execution)` is true when every settled attempt carries the mark. The money moved, and this execution did not move it. The execution is still `settled`. Only dispatch writes the mark, because dispatch is always this execution's first presentation of an id. Reconcile does not copy it: a lookup presents the attempt again, and the API answers every look at a settled attempt as a replay, this execution's own payment included. The tool results and a one-shot's `--json` read this predicate (`replayed`); `inspect` reads the same mark from the bundle's rail answers. An attempt closed by reconcile is still counted as paid by the execution that looked it up. §39c.

## Reconcile never re-dispatches

An execution left in `executing` is looked up on the rail, attempt by attempt. A recorded settled or failed outcome closes it; `in_flight`, `uncertain` or unknown leaves it in `executing` with `reason: rail_uncertain` for a human. The single exception is an outbox row still `pending` (the state changed, no call was ever made): those attempts go out once, under the same ids.

## The conversation loop

`AgentLoop.turn` (`agent.ts`) sends the model the system prompt, the conversation and the tool specs, and hands each tool call to the kit's handler for it; a tool outside `tools.json` is refused `tool_not_allowed`. Only the engine behind the handlers moves money. Two things it adds that no prompt can:

- **The reply language.** `detectLanguage` (`language.ts`) reads the language of what the person typed, Brazilian Portuguese or English, from function words; payee names, amounts and Pix keys count for neither. The loop appends a "Reply language for this turn" section naming it to the system prompt of every step of the turn. Tool results do not count: on the Messages API they are user-role messages, and a prompt rule alone lost to their Portuguese data. A turn with no lead either way keeps the previous turn's language, and before any lead the prompt's own default stands. The transcript's user line records `reply_language` (`null` before any lead). §64.
- **The date.** `ExecutionEngine.today()` is the date in the guardrails' timezone at the engine's clock, so `--now` pins it. `list_bills`, `list_payables` and `list_agreements` return it as `today`, and bills and payables also carry `days_until_due` (`daysUntil`), because the model has no calendar of its own.

## What the code prints, per locale

`locale.ts` and `strings.ts` (#64). A run has one locale, `pt-BR` or `en`: `--locale`, else the optional `locale:` of `agent.yaml`, else `pt-BR` (`resolveLocale`). `CORE_STRINGS` holds the lines every agent shares (the batch gesture, the waits, how an execution and a payable instrument read, the WhatsApp operator lines) in both locales, and `tableGaps` is what `npm run check` runs over it and over each kit's table: a key one locale lacks, an empty string, or a function whose arity differs is an error. `formatBRL` and `formatDay` format for the locale's reader ("R$ 1.850,00" / "R$1,850.00"; "30/09/2026" / "2026-09-30"). `WHATSAPP_LANGUAGE` maps a locale to the language Meta approves a template in (`pt_BR`, `en_US`); the template registry holds one copy per (name, language), and the check requires every template in the language of every locale. None of it touches what an answer decides, and it is independent of the reply language above.

## Stubs

`stubs/mandate-status.ts` (the section 4.7 status source for runs without a key: revocation, pause and the organization kill switch, over the local state.db) and `stubs/rail.ts` (the sandbox rail) are stand-ins for the CI, the scenarios and `rerun`, marked as such. With a test key the engine reads the mandate status from the API instead (`api/mandate-status.ts`, `GET /v1/mandates/{id}`), fail-closed: anything but `active` refuses `executing`, `org_paused: true` (the organization kill switch, ent#1648) refuses it whatever `status` says, and a read that does not answer, or answers without `org_paused`, is `mandate_status_unavailable`, never "assume active". The approval artifact is signed with a local development key (`approval.ts`); the API does not sign approval lists.
