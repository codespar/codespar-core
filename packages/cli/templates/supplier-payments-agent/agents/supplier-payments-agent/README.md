# supplier-payments-agent

[![rail: pix-out](https://img.shields.io/badge/rail-pix--out-2E8B57)](agent.yaml) [![capability: batch-payout](https://img.shields.io/badge/capability-batch--payout-1E6FBA)](agent.yaml) [![maturity: sandbox](https://img.shields.io/badge/maturity-sandbox-orange)](agent.yaml) [![approval: human | mandate](https://img.shields.io/badge/approval-human_%7C_mandate-555)](agent.yaml)

An agent that pays a company's suppliers, sales commissions and payroll over Pix, inside one mandate finance signs once: a cap per payout, a cap per month, named payees, one year of validity. It runs a batch as a **loop of executions, one per line** — so a refused payee is a fact about that payee, a wrong line is fixed and re-run alone, and running the same batch again pays nobody twice. It is born in `approval: human`, which is where most companies are, and what that mode leaves behind is the part a confirmation code never gives you: each line somebody approved, attested and bound both to the mandate and to the list it was one of.

## Quickstart

Node 22.13+. No key needed for the stub rail, and no money moves.

```sh
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
npm install                                                  # at the repo root, not inside agents/supplier-payments-agent
npm run start:supplier
> roda a folha de outubro
```

Three lines, three approvals, three receipts under `runs/<run-id>/receipts/`. Run it again and every line answers `already_settled`.

- `ANTHROPIC_API_KEY` can stay empty: the agent then replays a recorded transcript. The old placeholder `sk-ant-your_key_here` counts as empty.
- One-shot form: `npm start -- --input "roda a folha de outubro" --approve --json`.
- Sandbox rail: put a `csk_test_` key in `.env` (copy `.env.example`) and the agent talks to the CodeSpar sandbox instead of the stub. It needs a signed mandate in `.codespar/mandate.json`; unlike the bills-agent there is no in-terminal consent, because the mandate behind a payroll is the company's and is minted by whoever owns finance, not by whoever is at the keyboard.
- `npm start` inside `agents/supplier-payments-agent` works the same once the root is installed.

## What a batch is, and why it is not one execution

The spec's sentence is the whole design: *um lote é um laço de execuções sob um mandato, com um `attempt_id` por chamada: uma recusa não derruba as outras, e repetir não paga duas vezes.*

Both shapes deliver it, now that the core dispatches every attempt and names every one. (It did not: until the fix in PR #22 a multi-item execution stopped at the first refusal, so a four-line payout whose second payee the rail declined paid one and never dispatched the other two. That was a defect, not a property of the shape.) The trade is about what the **list** is, and a payroll wants one execution per line:

| Property | Where it comes from |
|---|---|
| One refusal does not stop the others | The loop in `src/modules/batch-payout.ts` `continue`s and never breaks. Each line reaches its own terminal state. |
| One `attempt_id` per call | The core derives it from each execution's own `idempotency_key`, so the rail's own idempotence covers each line separately. |
| Repeating pays nobody twice | A durable claim pairs (mandate, batch, line) with the execution covering it. Settled is skipped, still-open is never re-opened, and only an execution that ended without moving money is retried. |
| Each approved line stays attested | One approval artifact per line, each with its own `items_hash` bound to the mandate version. `runs/<run-id>/approval.json` holds them in approval order. |
| The approved list is bound as a set | The list is hashed once, before any line is drafted, and every artifact of the batch carries that `batch_hash` with the line's own position and the list's length. So a bundle of three artifacts says "1, 2 and 4 of 4" and not "three payments". A line the human denied has an execution and no artifact; a line that left the list after it was approved has neither, and the run that would drop it is refused before it drafts anything. |

The claim is taken **before** the channel can run the execution. Claiming afterwards would leave a settled payout unclaimed if the process died in between, and that is exactly the double payment. A crash the other way round leaves a claim on an open execution, which the next run reports as `in_progress` and refuses to duplicate — the operator closes it with `npm run approve`, `npm run resume` or `npm run reconcile`.

## What it shows

| Contract | How |
|---|---|
| The model proposes, the code executes | `codespar_pay` creates executions in `drafted`. Only `ExecutionEngine` in `@codespar/agent-core` checks mandate, caps, allowlist, `escalate_above` and `items_hash`, and only it reaches `executing`. |
| A batch cannot be fractioned | The lines come from `payables.ts`, never from the tool call. `codespar_pay` refuses `batch_ref` sent together with `items` or `total_minor`, so a model being steered cannot add a payee to a payroll or split one line into five. |
| Partial failure is visible | `scenarios/partial-batch-failure`: the rail declines one supplier, the other two settle, and the report names which line failed and why. |
| Two modes, one trail | `approval: human` (default): the operator approves each line. `approval: mandate`: the agent runs what the signed allowance covers and asks above `escalate_above`. Same code, same states, same receipts. |
| Readable refusal | Cap per payout, cap per month, payee outside the mandate, revoked mandate, outside hours: each names itself in the trail and in the chat. |
| Sandbox by construction | A key that does not start with `csk_test_` fails before any network call. |

## What is sandbox, what the agent applies alone, what is out

Read from `agent.yaml`, field `maturity`:

| Capability | Maturity | Meaning |
|---|---|---|
| `pix-out` | sandbox | Pix payouts through the CodeSpar sandbox. No real money. |
| `batch-payout` | sandbox | The loop of executions, the per-line claim and the partial-failure report. |
| `receipt-verification` | sandbox | Every receipt sealed since the API added Ed25519 carries a signature anybody can check against the published key set: `npm run verify -- runs/<run-id>/receipts/<id>.json`. Receipts sealed before that carry none and never will. |

What the agent applies on its own, before the mandate (`guardrails.json`): the escalation thresholds (R$ 1.500,00 per payout, first payout to each payee, 22:00–07:00), a 24-hour velocity window per payee against fractioning, and "the core's total wins" when the model states another.

Not in this kit: WhatsApp, `embedded-consent` (see above), scheduling a batch for a future date, and any notion of a payroll calendar — the payables file is a fixture, not an ERP.

## Commands

| Command | Does |
|---|---|
| `npm start` | Interactive terminal on the stub rail (or the sandbox, with a `csk_test_` key and a signed mandate). |
| `npm start -- --input "roda a folha de outubro" [--approve] [--json] [--now <ISO>]` | One turn, no prompt. `--approve` decides every line of the batch the same way. `--json`: machine data on stdout, people on stderr. `--now 2026-09-23T14:00:00-03:00` pins the clock the guardrails read (`escalate_above.outside_hours`) instead of the wall clock; `CODESPAR_AGENT_NOW` is the same pin for every command. |
| `npm start -- --scenario <name> [--mode human\|mandate]` | A scenario pack from `scenarios/`. |
| `npm run check` | The manifest gate: fails if the prompt, tools or guardrails contradict `agent.yaml`, if `AGENTS.md` and `CLAUDE.md` differ, or if `mcp`, `cli` or `schema` are missing. |
| `npm run eval` | The adversarial suite (`evals/adversarial/`) and every scenario in every mode, on the replay provider. |
| `npm run approve <execution-id>` / `npm run deny <execution-id>` | Decides one line left in `awaiting_approval`. A batch left undecided is decided line by line, which is the same granularity the terminal asks at. |
| `npm run resume` | After a crash: dispatches only what the outbox proves was never sent, reconciles the rest from the rail, expires what went stale. Never pays twice. |
| `npm run rerun <run-id>` | Replays a recorded run with no network and checks the state sequence matches. |
| `npm run inspect <run-id> [--json] [--html <file>]` | Reads a run's proof bundle back as a timeline. On a batch it prints the header once — the `batch_hash`, how many lines the approved list held, how many are attested here — and then one timeline per line. `2 of 4 line(s) attested · 3 with an execution · no execution for line(s) 3` is what a batch that did not all run looks like when you read it back. |
| `npm run verify -- <receipt-file> [--json] [--keys <file>] [--url <url>]` | Checks a receipt's Ed25519 signature against CodeSpar's published key set. No key and no agent needed: it runs on a receipt file copied to another machine. The exit code is the verdict — 0 verified, 1 tampered, 3 unsigned, 4 unknown key, 5 the key set could not be read, 6 not a receipt. |
| `npm run reconcile` | Compares local state with the rail. Closes an `executing` execution only from a recorded rail outcome; what the rail has not answered stays `executing` with an `execution.uncertain` event, for a human. Never dispatches. |

## The proof bundle

Every run writes `runs/<run-id>/`:

```
transcript.jsonl        the conversation and the tool calls
approval.json           the approval artifacts of the run — for a batch, one per line, in approval order
mandate.snapshot.json   the mandate as it was, keys masked
events.jsonl            every transition and every rail event, each with its actor
receipts/               the receipts the rail returned, each stamped with the actor
run.json                mode, rail, mandate id
```

No key and no secret is written there. Payee keys are masked.

The receipt copies carry both of the API's seals. `receipt_sig` is the HMAC, which proves the payment to whoever runs this agent; `receipt_sig_ed25519` and `receipt_sig_kid` are the asymmetric half, which proves it to anybody:

```sh
npm run verify -- runs/<run-id>/receipts/<receipt-id>.json
```

That reads the public key set from `/.well-known/codespar-receipt-keys.json`, picks the key the receipt names, rebuilds `codespar-receipt:v1:<receipt_id>:<chain>` and checks it with stock `node:crypto` — no key, no API key, no CodeSpar call that could be refused. `--keys <file>` uses a saved copy of the key set instead and touches no network at all; `--json` puts the verdict on stdout. `--url` names another deployment's key set: the default is production, and every deployment publishes its own key under the same `kid`, so a sandbox receipt checked against the production keys reads `tampered`. The signature covers the receipt id and the chain, so the masking above does not disturb it, and the file verifies on a machine that has never seen this repository. A receipt sealed before the API had the capability answers `unsigned`, which is not a failure: it has no Ed25519 signature and never will, and its HMAC seal is unaffected.

## Limits and stubs

- The receipt carries two signatures. The HMAC one proves the payout to whoever runs this agent, because verifying it means holding the secret that also mints it. The Ed25519 one, sealed by CodeSpar's platform issuer key since the API added it, proves it to anybody with `npm run verify`. A receipt sealed before that carries no Ed25519 signature and never will — there is no backfill, and signing an old receipt with today's key would attest to what the database says now, not to what happened then.
- The approval artifact is signed by HMAC with a **local development key** (`.codespar/approval.key`). This is a stub: the CodeSpar API does not sign approval lists today. It proves what was approved to whoever runs the agent.
- The claim that makes a re-run safe is **local**, in `.codespar/state.db`. Delete that file and the agent has no memory that a batch already ran. The rail's own idempotence still covers a re-sent `attempt_id`, but the executions would be new ones with new attempt ids, so it would not catch them. This is the honest limit of a kit that runs on one machine; see `docs/OPEN_QUESTIONS.md`.
- The batch is not atomic and does not try to be. Lines settle independently, so a batch can end part paid. That is the point, and the report says which lines those are.
- `batch_hash` binds the list; it does not bind the list to the payables file it came from. A batch whose lines changed is refused on the next run of the SAME `batch_ref`, because that is when there is an approved set to contradict. A list edited before it was ever presented is simply the list, and the mandate's allowlist and caps are what stand between it and a payment.
- The hash is over the resolved payees, so re-signing the mandate with a different Pix key for a payee moves it too, and the next run of an already-approved batch is refused. That is correct — where the money goes did change — but the refusal cannot see WHY, so it names what it measured and offers both ways out rather than guessing.
- Revocation is checked before every `executing`. Without a key the same check answers from a local stub (`packages/agent-core/src/stubs/mandate-status.ts`), which is also where the organization kill switch lives.
- CodeSpar does not host or run this agent. The repository delivers it; whoever runs it, runs it.

## Going to production

Swap the stub for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the approved `consumer_id`, the signed mandate, the webhook endpoint. What does not: the code, `agent.yaml`, the `approval` key.
