# collections-agent

The merchant's agent that collects. The payer answers the message about an open agreement; the agent proposes terms inside a negotiation envelope (discount ceiling, instalments, due-date window, collection hours); on acceptance the code issues one bolepix per instalment with an idempotency key, shows the QR and the copy-and-paste in the conversation, and closes the cycle when `commerce.charge.paid` or `commerce.charge.expired` arrives: "recebemos, acordo quitado". Terminal first; WhatsApp later.

```
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/collections-agent/.env.example agents/collections-agent/.env   # CODESPAR_API_KEY (csk_test_...) and ANTHROPIC_API_KEY
npm install && npm start --workspace=agents/collections-agent
pagador> oi, recebi a mensagem sobre o acordo do pedido 1042
```

`npm install` runs at the repository root (it is an npm workspace). You type as the payer; the operator's approval, in `human` mode, is asked on the same keyboard and labelled `[operador]`.

## What it proves

| Contract | How |
|---|---|
| The model proposes, the code executes | `codespar_charge` creates an execution in `drafted`. Only `ExecutionEngine` in `@codespar/agent-core` checks the collection policy (debtors' book, cap per receivable, window cap), the envelope, `escalate_above` and `items_hash`, and only it reaches `executing`. |
| The envelope is code, not prompt | `guardrails.envelope` is the `policyExtension` the core runs at every gate: a discount above the ceiling, more instalments than allowed, a due date outside the window or a message outside collection hours is `denied` with reason `outside_envelope` or `outside_hours`, in both modes, whatever anyone typed. |
| One receivable per instalment, once | Each instalment is one `POST /v1/charges` (`method: boleto` + `due_date`, the cobranca com vencimento the payer settles by Pix or boleto) with `idempotency_key` = the attempt id. A retry returns the same charge. `GET /v1/charges/{id}` accepts that key, which is what lets a restart find the charge instead of issuing again. |
| The cycle closes on the state machine | An accepted receivable leaves the execution in `executing` with reason `awaiting_settlement`. `commerce.charge.paid` moves it to `settled`; `expired` and `cancelled` to `failed` with that reason. Duplicate events are dropped by id; `paid` after `expired`, or the reverse, moves nothing; the payer is told once. |
| Two modes, one envelope | `approval: human` (default): the operator approves each issuance. `approval: mandate`: the agent issues alone inside the envelope and asks the operator above R$ 3.000,00. Same code, same states, same records. |
| Readable refusal | Discount, instalments, due date, hours, cap, unknown debtor, revoked policy: each names itself in the trail and in the chat. |
| Survives a restart | Kill the process after the issuance, run `npm run resume` then `npm run poll`: one charge, one settlement. |
| Sandbox by construction | A key that does not start with `csk_test_` fails before any network call. The sandbox payer is a test-environment route the API refuses to a live key. |

## How the loop closes: poll, and a webhook when you have one

The API delivers `commerce.charge.*` through triggers to a URL. A terminal has none, so the kit's default is to LOOK: `GET /v1/charges/{id}` every three seconds (the stub's fixture, offline) through the core's `reconcile`, which is read-only on the rail and never re-issues. The first look that finds the instrument payable prints the QR (as an image, in the terminal) with the copy-and-paste under it; the look that finds it paid or expired closes the execution and tells the payer once. `npm run poll` continues after a restart or a timeout; nothing shown twice, nothing said twice, because both marks live in `state.db`.

`channels/webhook/` is the other closer, a documented stub: the receiving contract of a trigger delivery (`X-CodeSpar-Signature: t=..,v1=..`, body `{ id, type, data: { payment_id } }`), signature verification with the trigger's secret, dedup by event id, and `npm run webhook` to run it on localhost. Registering the trigger and exposing the URL are the developer's steps (`codespar triggers create`). See `docs/OPEN_QUESTIONS.md` section 21.

## The sandbox payer

With a test key, the debtor is `POST /v1/test/charges/{chargeId}/pay` (alias `POST /v1/charges/{chargeId}/sandbox/pay`): the charge goes through the same settlement path a provider `charge-in` webhook takes, `commerce.charge.paid` fans out to the project's triggers, and every record carries `simulated: true` and `settled_against: "sandbox_fixture"`. No money moves anywhere. The kit calls it only when a scenario says `payer: pays` or you pass `--simulate-payer`. In the CI the payer is the fixture inside the stub rail (`packages/agent-core/src/stubs/charge-rail.ts`).

## What is sandbox, what the agent applies alone, what is out

Read from `agent.yaml`, field `maturity`:

| Capability | Maturity | Meaning |
|---|---|---|
| `bolepix-receivables` | sandbox | Cobranca com vencimento through the CodeSpar sandbox, paid by the sandbox payer. No real money. |
| `receipt-verification` | blocked | Waits for Ed25519; and the API seals no record for a paid charge today (the paid charge as the API reports it is what the bundle keeps, marked `kind: "charge"`, unsealed). |

What the agent applies on its own (`guardrails.json`): the envelope (15% maximum discount, up to 3 instalments, due dates within 90 days, R$ 50,00 minimum instalment, collection hours 08:00–20:00 in America/Sao_Paulo), the escalation threshold (R$ 3.000,00 per agreement in `mandate`), and "the core's total wins" when the model states another.

Out of this delivery: WhatsApp, a policy signed by the API for the receiving side (section 16 of the spec: candidate to product), `npm run inspect`, the `codespar init --template` scaffold.

## Commands

| Command | Does |
|---|---|
| `npm start` | Interactive terminal. You are the payer; the operator's approval is asked on the same keyboard. |
| `npm start -- --input "oi, recebi a mensagem sobre o acordo do pedido 1042" [--approve] [--simulate-payer] [--wait 60] [--json]` | One turn, no prompt. Without `ANTHROPIC_API_KEY` it replays the recorded scenario whose first turn is that input. `--json`: machine data on stdout, people on stderr (add npm's `-s` when piping). Exit code 3 when a receivable is still waiting. |
| `npm start -- --scenario <name> [--mode human\|mandate] [--rail stub\|api]` | A scenario pack from `scenarios/`. With `--rail api` and a test key the charge, the poll and the sandbox payer are real, and `cycle_seconds` is measured. |
| `npm run check` | The manifest gate: fails if the prompt, tools or guardrails contradict `agent.yaml`, if `AGENTS.md` and `CLAUDE.md` differ, or if `mcp`, `cli` or `schema` are missing. |
| `npm run eval` | The adversarial suite (`evals/adversarial/`) and every scenario in every mode, on the replay provider and the stub rail. |
| `npm run approve <execution-id>` / `npm run deny <execution-id>` | The operator's decision as its own command: decides an execution left in `awaiting_approval`, writes the section 4.2 artifact, runs it through the same last gate `npm start` uses, and waits for the payer (`--wait`, `--simulate-payer`). |
| `npm run poll [--wait <s>] [--simulate-payer]` | Keeps looking at every receivable still waiting for its payer. Shows an instrument not shown yet, tells the payer the outcome once, fetches the paid record. |
| `npm run webhook [--port 8787] [--secret <trigger secret>]` | The receiving end of `channels/webhook` on localhost. A stub: you register the trigger and expose the URL. |
| `npm run resume` | After a crash: dispatches only what the outbox proves was never sent, reconciles the rest from the rail. Never issues twice. |
| `npm run rerun <run-id>` | Replays a recorded run with no network and checks the state sequence matches; the payer's behaviour (paid, expired) is read from the recording. |
| `npm run reconcile` | Compares local state with the rail. One look, read-only; names what is waiting for a payer, what is uncertain, what record is missing locally. |

## The proof bundle

Every run writes `runs/<run-id>/`:

```
transcript.jsonl        the conversation and the tool calls
approval.json           the approval artifacts of the run (section 4.2 of the spec)
mandate.snapshot.json   the collection policy as it was, debtors' documents masked
events.jsonl            every transition, every look, every charge event, every message to the payer, each with its actor
receipts/               the paid charges as the API reports them, each stamped with the actor (kind: charge, unsealed)
run.json                mode, rail, policy id
```

No key and no secret is written there. Documents are masked; the payer's document is never in a message.

## What this README declares

- A policy for the receiving side, signed by the organization, does not exist in the API; the collection policy is the merchant's own file (`mandate.example.json`, in the shape of the consumer mandate, where the named entries are the debtors with an open agreement) and the envelope is the kit's code. Candidate to product (section 16 of the spec).
- The approval artifact is signed by HMAC with a **local development key** (`.codespar/approval.key`). This is a stub: the CodeSpar API does not sign approval lists today. It proves what was approved to whoever runs the agent.
- The API seals no record for a paid charge. The bundle keeps the paid charge as the API reports it, with `simulated: true` when the sandbox payer paid it. Nothing here is proof to anyone outside the merchant.
- Revocation and the kill switch run against a **local stub** of the AgentGate (`packages/agent-core/src/stubs/agentgate.ts`); the collection policy has no API-side status to read.
- The `actor` of every call is carried locally on every event, approval and record copy. The API has no `actor` field on the wire today.
- Collection over WhatsApp has rules: hours, secrecy of the debt, no embarrassment, LGPD. The prompt codifies them; the envelope enforces the hours; the code never sends a document.
- CodeSpar does not host or run this agent. The repository delivers it; whoever runs it, runs it.
- What the agent issues inside the policy was authorized by the merchant, and the approval artifact proves what. The split of loss between partner, institution and CodeSpar on an authorized but wrong receivable is contractual and not yet written.

## Going to production

Swap the `csk_test_` key for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the debtors' book (your ERP instead of `src/agreements.ts`), the webhook endpoint for `commerce.charge.*` (or keep the poll), the payer (a real person, not the sandbox route). What does not: the code, `agent.yaml`, the `approval` key, the envelope.
