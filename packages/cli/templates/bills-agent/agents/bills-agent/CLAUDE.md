# Rules for the coding agent working on bills-agent

You are editing a reference agent of the CodeSpar Agent Starter Kits. These rules keep it a reference.

1. **Read `agent.yaml` before editing anything.** It is the index. `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and `mandate.example.json` must agree with it, and `npm run check` fails when they do not.
2. **Do not widen `tools.json` or the mandate without asking.** The tool list is closed on purpose; the mandate's caps and payees are the person's, not yours. Adding a tool or a payee is a product decision, not a refactor.
3. **The model proposes, the code executes.** Nothing you write may let a model output reach `executing` without going through `ExecutionEngine` in `@codespar/agent-core`. If you need a new check, add it to the core, not to the prompt.
4. **`escalate_above` only tightens.** A trigger may send an execution to a human; it may never raise a cap or add a payee.
5. **`actor` on everything.** Every event, approval and receipt copy carries who acted. A receipt without an actor fails the CI.
6. **Sandbox by construction.** Only `csk_test_` keys. Never commit `.env`, `.codespar/` or `runs/`. The pre-commit secret scan and the CI both refuse a key-shaped string.
7. **Before you say a task is done:** `npm run check`, `npm run eval` (adversarial suite plus scenarios, on the replay provider, no model needed) and `npm test` at the repository root. All green, or it is not done.
8. **Use the CodeSpar MCP and skills** (`@codespar/mcp@0.5.8`, pinned in `agent.yaml`) to learn the real API. When the spec in `docs/spec-v5.1.1.md` and the API diverge, follow the API and log it in `docs/OPEN_QUESTIONS.md`.
9. **Say which signature you mean.** A receipt sealed since the API added Ed25519 carries a signature anybody can check against the published key set, with no credential — that is what `npm run verify -- <receipt-file>` does. "Verifiable by a third party" is true of THAT and of nothing else here: a receipt sealed before the change carries no Ed25519 signature and never will, and the approval artifact is still HMAC with a local development key. Write the phrase only where `Ed25519` is written too; `npm run check` fails otherwise.
10. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file; the CI fails if they diverge. Edit both or neither.
