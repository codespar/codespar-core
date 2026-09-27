# Rules for the coding agent working on checkout-agent

You are editing a reference agent of the CodeSpar Agent Starter Kits. These rules keep it a reference.

1. **Read `agent.yaml` before editing anything.** It is the index. `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and `mandate.example.json` must agree with it, and `npm run check` fails when they do not.
2. **Do not widen `tools.json`, the sales policy or the envelope without asking.** The tool list is closed on purpose; the customer book, the caps, the price table, the discount ceilings, the margin floor and the coupon table are the merchant's, not yours. Adding a tool or loosening the envelope is a product decision, not a refactor.
3. **No tool takes a price.** A cart line is `{ sku, quantity }` plus at most a discount in percent; the charge takes no amount. The prices are the catalog's and the totals the code's. `test/adversarial.test.ts` walks every `input_schema` and fails on a price, unit price or total field other than the recorded `total_minor`. Do not add one, under any name.
4. **The model proposes, the code executes.** Nothing you write may let a model output reach `executing` without going through `ExecutionEngine` in `@codespar/agent-core`. The envelope is a `policyExtension` the core runs at every gate; a new check goes there or in the core, never in the prompt.
5. **The cart is replaced, never merged, and the order follows it.** `cart_update` takes the whole list. A cart changed while its order is open restates the order (`engine.restate`), and the last gate compares the order with its approval artifact, `composition` included: that is what sends a cart changed after approval back to the attendant. Do not add a path that edits a cart without going through that.
6. **`escalate_above` only tightens.** A trigger may send an order to the attendant; it may never raise a cap, add a customer or loosen the envelope.
7. **`actor` on everything.** Every event, approval and paid-order copy carries who acted. A record without an actor fails the CI.
8. **Sandbox by construction.** Only `csk_test_` keys. Never commit `.env`, `.codespar/` or `runs/`. The pre-commit secret scan and the CI both refuse a key-shaped string. The sandbox payer (`POST /v1/test/charges/{id}/pay`) is test-environment only.
9. **One order, one charge, one `idempotency_key`.** The key is the attempt id; asking to issue twice returns the same charge. Do not touch that.
10. **The order closes on the state machine, not on prose.** `commerce.charge.paid` (or a status read that sees it paid) settles; `expired` and `cancelled` fail. A customer saying they paid moves nothing. `commerce.charge.payment_notified` is not a payment.
11. **Before you say a task is done:** `npm run check`, `npm run eval` (adversarial suite plus scenarios, on the replay provider, no model needed) and `npm test` at the repository root. All green, or it is not done.
12. **Use the CodeSpar MCP and skills** (`@codespar/mcp@0.5.8`, pinned in `agent.yaml`) to learn the real API. When the spec and the API diverge, follow the API and log it in `docs/OPEN_QUESTIONS.md`.
13. **Do not write "verifiable by a third party"** anywhere in this agent. The Ed25519 seal a third party can check exists on a PAYMENT receipt; this agent issues charges, and the API seals no record for a paid charge. The approval artifact is HMAC with a local key.
14. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file; the CI fails if they diverge. Edit both or neither.
