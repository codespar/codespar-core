# Rules for the coding agent working on collections-agent

You are editing a reference agent of the CodeSpar Agent Starter Kits. These rules keep it a reference.

1. **Read `agent.yaml` before editing anything.** It is the index. `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and `mandate.example.json` must agree with it, and `npm run check` fails when they do not.
2. **Do not widen `tools.json`, the collection policy or the envelope without asking.** The tool list is closed on purpose; the debtors' book, the caps and the envelope (discount, instalments, due-date window, collection hours) are the merchant's, not yours. Adding a tool or loosening the envelope is a product decision, not a refactor.
3. **The model proposes, the code executes.** Nothing you write may let a model output reach `executing` without going through `ExecutionEngine` in `@codespar/agent-core`. The envelope is a `policyExtension` the core runs at every gate; if you need a new check, add it there or to the core, never to the prompt.
4. **`escalate_above` only tightens.** A trigger may send an execution to an operator; it may never raise a cap, add a debtor or loosen the envelope.
5. **`actor` on everything.** Every event, approval and receipt copy carries who acted. A record without an actor fails the CI.
6. **Sandbox by construction.** Only `csk_test_` keys. Never commit `.env`, `.codespar/` or `runs/`. The pre-commit secret scan and the CI both refuse a key-shaped string. The sandbox payer (`POST /v1/test/charges/{id}/pay`) is test-environment only and the code never calls it with anything else.
7. **One receivable per instalment, one `idempotency_key` per receivable.** The key is the attempt id; a retry must return the same charge, never a second one the same debtor could pay twice. Do not touch that.
8. **The cycle closes on the state machine, not on prose.** `commerce.charge.paid` settles; `expired` and `cancelled` fail. By poll (`GET /v1/charges/{id}`) or by webhook (`channels/webhook`), once and only once. A duplicate event never sends the debtor a second message.
9. **Before you say a task is done:** `npm run check`, `npm run eval` (adversarial suite plus scenarios, on the replay provider, no model needed) and `npm test` at the repository root. All green, or it is not done.
10. **Use the CodeSpar MCP and skills** (`@codespar/mcp@0.5.8`, pinned in `agent.yaml`) to learn the real API. When the spec in `docs/spec-v5.1.1.md` and the API diverge, follow the API and log it in `docs/OPEN_QUESTIONS.md`.
11. **Do not write "verifiable by a third party"** anywhere. The approval artifact is HMAC with a local key, and the API seals no record for a paid charge today.
12. **Collection has rules** (hours, secrecy of the debt, no embarrassment, LGPD). The prompt codifies them and the envelope enforces the hours. Do not loosen either.
13. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file; the CI fails if they diverge. Edit both or neither.
