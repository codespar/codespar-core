# @codespar/agent-core

The primitives every CodeSpar starter-kit agent inherits (spec v5.1.1, section 4): the execution state machine, the approval artifact, the `agent.yaml` manifest, `escalate_above`, `actor`, local state in SQLite, the proof bundle, the rail contract and the two providers.

This package is the decisions. The RUNNER around them — the terminal channel, `codespar-agent start|consent|approve|deny|resume|rerun|reconcile|poll|webhook|check|eval`, the setup that wires this package to an agent directory, and the scenario and adversarial runners — is [`@codespar/agent-runtime`](../agent-runtime), which depends on this one and is what an agent's `package.json` scripts call (#13). Nothing here knows an agent's name.

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

## Reconcile never re-dispatches

An execution left in `executing` is looked up on the rail, attempt by attempt. A recorded settled or failed outcome closes it; `in_flight`, `uncertain` or unknown leaves it in `executing` with `reason: rail_uncertain` for a human. The single exception is an outbox row still `pending` (the state changed, no call was ever made): those attempts go out once, under the same ids.

## Stubs

`stubs/mandate-status.ts` (the section 4.7 status source for runs without a key: revocation, pause and the organization kill switch, over the local state.db) and `stubs/rail.ts` (the sandbox rail) are stand-ins for the CI, the scenarios and `rerun`, marked as such. With a test key the engine reads the mandate status from the API instead (`api/mandate-status.ts`, `GET /v1/mandates/{id}`), fail-closed: anything but `active` refuses `executing`, `org_paused: true` (the organization kill switch, ent#1648) refuses it whatever `status` says, and a read that does not answer, or answers without `org_paused`, is `mandate_status_unavailable`, never "assume active". The approval artifact is signed with a local development key (`approval.ts`); the API does not sign approval lists.
