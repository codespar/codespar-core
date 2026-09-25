# collections-agent

[![rail: bolepix](https://img.shields.io/badge/rail-bolepix-2E8B57)](agent.yaml) [![maturity: sandbox](https://img.shields.io/badge/maturity-sandbox-orange)](agent.yaml) [![approval: human | mandate](https://img.shields.io/badge/approval-human_%7C_mandate-555)](agent.yaml) [![charge → settled: 10 s](https://img.shields.io/badge/charge_%E2%86%92_settled-10_s-8A2BE2)](#quickstart)

The merchant's collections agent. A customer replies about an open debt; the agent proposes terms inside a negotiation envelope (maximum discount, number of instalments, due-date window, collection hours), and once the customer accepts, the code issues one bolepix per instalment, shows the QR code and the copy-and-paste Pix code in the chat, and closes the loop when the charge is paid or expires. Two channels: the terminal, and WhatsApp against a local Cloud API emulator that needs no Meta account.

## Quickstart

Node 22.13+ and a sandbox key (`csk_test_...`) from [codespar.dev/auth/signup](https://codespar.dev/auth/signup). No money moves: a sandbox payer plays the customer's bank.

```sh
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/collections-agent/.env.example agents/collections-agent/.env   # paste your csk_test_ key
npm install                                                              # at the repo root (npm workspace)
npm run start:collections
pagador> oi, recebi a mensagem sobre o acordo do pedido 1042
```

You type as the customer. In `human` mode the operator's approval is asked on the same keyboard, labelled `[operador]`. Without a real `ANTHROPIC_API_KEY` (empty or the `.env.example` placeholder) the agent replays the recorded scenario.

Scaffold instead of cloning: `npx -y @codespar/cli@0.14.0 init my-agent --template collections-agent`.

## What it shows

| Contract | How |
|---|---|
| The model proposes, the code executes | `codespar_charge` creates an execution in `drafted`. Only `ExecutionEngine` in `@codespar/agent-core` checks the collection policy (debtors' book, cap per receivable, window cap), the envelope, `escalate_above` and `items_hash`, and only it reaches `executing`. |
| The envelope is code, not prompt | `guardrails.envelope` is the `policyExtension` the core runs at every gate: a discount above the ceiling, more instalments than allowed, a due date outside the window or a message outside collection hours is `denied` with reason `outside_envelope` or `outside_hours`, in both modes, whatever anyone typed. |
| One receivable per instalment, once | Each instalment is one `POST /v1/charges` (`method: boleto` + `due_date`, the cobranca com vencimento the payer settles by Pix or boleto) with `idempotency_key` = the attempt id. A retry returns the same charge. `GET /v1/charges/{id}` accepts that key, which is what lets a restart find the charge instead of issuing again. |
| The cycle closes on the state machine | An accepted receivable leaves the execution in `executing` with reason `awaiting_settlement`. `commerce.charge.paid` moves it to `settled`; `expired` and `cancelled` to `failed` with that reason. Duplicate events are dropped by id; `paid` after `expired`, or the reverse, moves nothing; the payer is told once. |
| Two modes, one envelope | `approval: human` (default): the operator approves each issuance. `approval: mandate`: the agent issues alone inside the envelope and asks the operator above R$ 3.000,00. Same code, same states, same records. |
| Readable refusal | Discount, instalments, due date, hours, cap, unknown debtor, revoked policy: each names itself in the trail and in the chat. |
| Survives a restart | Kill the process after the issuance, run `npm run resume` then `npm run poll`: one charge, one settlement. |
| Closes days later, on the channel | `npm run poll -- --channel whatsapp` comes back to a conversation whose run ended, and confirms by approved template once the 24-hour window has shut. |
| Sandbox by construction | A key that does not start with `csk_test_` fails before any network call. The sandbox payer is a test-environment route the API refuses to a live key. |

## How the loop closes: poll, and a webhook when you have one

The API delivers `commerce.charge.*` through triggers to a URL. A terminal has none, so the kit's default is to LOOK: `GET /v1/charges/{id}` every three seconds (the stub's fixture, offline) through the core's `reconcile`, which is read-only on the rail and never re-issues. The first look that finds the instrument payable prints the QR (as an image, in the terminal) with the copy-and-paste under it; the look that finds it paid or expired closes the execution and tells the payer once. `npm run poll` continues after a restart or a timeout; nothing shown twice, nothing said twice, because both marks live in `state.db`.

The webhook is the other closer, a documented stub (`packages/agent-runtime/src/webhook.ts`, `npm run webhook`; there is no `channels/webhook/` directory, and since wave 4 `channels/` means something specific): the receiving contract of a trigger delivery (`X-CodeSpar-Signature: t=..,v1=..`, body `{ id, type, data: { payment_id } }`), signature verification with the trigger's secret, dedup by event id, and `npm run webhook` to run it on localhost. Registering the trigger and exposing the URL are the developer's steps (`codespar triggers create`). See `docs/OPEN_QUESTIONS.md` section 21.

## The WhatsApp channel

This is the agent WhatsApp is for: the debtor answers a message, the agent
proposes terms, the payable code goes into the conversation, and "recebemos,
acordo quitado" closes it. The channel has two backends behind one interface,
and they are **the same code with a different base URL**.

The house simulator is [`dyvit-wa-sim`](https://github.com/fabianocruz/whatsapp-simulator)
(MIT), a local emulator of the WhatsApp Cloud API, published to npm as
`@dyvit/whatsapp-simulator-cli`. It is not ours and it is not a dependency:
`npm run whatsapp:emulator` fetches the pinned version with `npx` and runs it on
`127.0.0.1:4290`. Start it in one terminal, run the agent in another:

```sh
npm run whatsapp:emulator                                 # terminal 1
npm run start:collections -- --channel whatsapp --conversation acordo-1042
npm run start:collections -- --channel whatsapp --conversation acordo-1042 --scripted --mode mandate --simulate-payer --now 2026-09-23T14:00:00-03:00
```

`--conversation` is required because the agent ships two, and which person you
are messaging is not a default: `acordo-1042` is Joana and ends paid,
`acordo-1103` is Ana Paula and ends expired (add `--payer expires`).

**Why somebody else's emulator instead of a fake in this repo.** A mock we
wrote would agree with us by construction — it would accept our payloads
because we wrote both sides, and the day Meta refused one we would find out in
production. This one answers `POST /v22.0/{phone-number-id}/messages` with the
Cloud API's own response shape and posts back the same signed
`x-hub-signature-256` webhooks, so what runs against it is the adapter itself.
It also has a clock we can move (`POST /_sim/clock`), which a replay finishing
in seconds cannot otherwise have. No Meta account, no credential, and no
traffic that leaves the machine. What it does NOT cover is measured, with the
exact payloads, in `docs/OPEN_QUESTIONS.md` §46 — chief among them that it
prices the 24-hour window but does not enforce it.

`--scripted` replays the debtor's turns from `channels/whatsapp/<name>.json`,
which is what an agent ships for this channel: the contact the conversation is
bound to, the agreement it may be about, and the person's turns. Each turn is
pushed through the emulator's `POST /_sim/inbound`, so a scripted turn takes
the same path a real one would — including the signature check on the way
back. The behaviour is the runner's (`packages/agent-runtime/src/channels/`);
the conversations are the agent's, and `npm run check` fails if the two
disagree in either direction.

**The rules are above the backend, so a backend is not a way around one.**
Every outbound message is checked before anything carries it: nothing outside
the collection hours (`guardrails.envelope.collection_hours`), nothing to a
contact other than the one the conversation is bound to, nothing naming
another debtor's agreement (by its alias, which is what the agent's own book calls it), and no CPF or CNPJ in a message. A refused message
is not a failed delivery — it never left the process — and it is recorded as
such in the conversation log. A Pix copy-and-paste and a boleto line are their
own message kind and are not read as prose, which is why the document rule does
not refuse the thing that pays.

**The operator is not on WhatsApp.** In `approval: human` the question is asked
on the operator's console and never in the conversation; that is not a check,
it is the wiring. One caveat, and it is a real one: an INTERACTIVE simulator
run reads both the debtor's turns and the operator's answer from the same
keyboard, so one person plays both parts. `--scripted` has no such problem,
and a scripted `human` run without `--approve` is refused rather than left
waiting.

**Going live is a base URL.** `--backend cloud-api` reads
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`
and `WHATSAPP_APP_SECRET` from your `.env` (commented out and empty in
`.env.example`) and refuses to open without them, by name. It is the same
class the emulator runs, pointed at `graph.facebook.com` instead — which is
also how the channel decides it is live, and therefore how the
consent-evidence builder decides an act was observed by somebody.
**This repo has never run one against Meta**: the shapes are written from
Meta's published documentation, and the first live run is yours. Two pieces
are stubs and say so: template APPROVAL (a Meta Business account reviews
templates; the channel only knows the names this agent declares) and sending
the QR as an IMAGE (that needs a media upload or a public URL, and this repo
hosts neither, so the copy-and-paste goes as its own text message — which is
the string that pays; the emulator would accept the image, so that gap is
ours).

**The conversation is part of the proof.** Each run writes `channel.jsonl` into
its bundle: every message in and out, in order, with the delivery state and any
refusal, and the contact masked, because the bundle travels. Inbound lines also
carry the PROVIDER's timestamp, which is what a later process counts the
24-hour window from — see the poll below.

### Agreed on Tuesday, paid on Friday

The ordinary collection does not close inside the turn that issued the charge.
The debtor agrees now and pays days later, and by then WhatsApp's 24-hour
customer-service window has shut: the only thing a business may send is a
template Meta approved in advance.

```sh
npm run poll -- --channel whatsapp --conversation acordo-1042
```

It comes back to the conversation from the RECORD — the bundle's
`channel.jsonl` plus `state.db` — looks at the receivable the way the terminal
poll does, and puts the outcome back into that same conversation, appended
under the QR it confirms rather than into a second folder. **Free-form while
the window is open, template once it has shut**, and which of the two is the
window's decision, not the command's.

Three things it will not do. Nothing waiting for a payer is a clean no-op that
exits 0 and never opens the channel — a cron that fails on an empty queue is a
cron somebody turns off. Polling twice tells the person once, because the
cursor that says so lives in `state.db` and outlives the process. And a charge
that expired gets the expiry template, never the paid one.

Which executions belong to the conversation is decided by its `subject` — the
agreement alias it is allowed to name. That is the same rule that keeps one
debtor's agreement out of another's chat, used in the other direction.

**The templates are the agent's**, declared in
[`channels/whatsapp/templates.json`](channels/whatsapp/templates.json) with the
name, the language and the body as submitted. `npm run check` validates it, and
the channel refuses a name nobody declared, a language the template was not
registered in, and a variable count the body has no placeholders for — the
three things a local registry can see that Meta answers with a 4xx. Whether
Meta APPROVED a template is not knowable from here and stays yours.

**Consent in the conversation is wired and deliberately unused here.**
`attestation.evidence` on the consent submit accepts four keys on this channel
(`contact`, `message_id`, `session_id`, `provider_ts`) and the channel builds
exactly those — but only from a backend that talked to a real provider, which
is decided by the base URL being Meta's. An act the emulator observed was
observed by nobody, so the builder refuses and says why. This agent has no
consent step to carry it either: the collection policy is the merchant's own
file. See `docs/OPEN_QUESTIONS.md` section 43.

### The gate

`npm run whatsapp:gate` runs the whole cycle three times from a clean state,
with nobody at a keyboard, and asserts the final state and the shape of the
conversation each time — not the wording. It needs the emulator running and
FAILS rather than skips when it is not, so the gate never passes against
nothing. It runs in the CI, which starts the emulator in its own step.

A fourth run covers the case the other three cannot reach: agree, move the
conversation's clock 26 hours, let the sandbox payer pay, poll. It asserts the
execution settled and the confirmation went out as a TEMPLATE. Read that
precisely: the emulator PRICES the 24-hour window and does not ENFORCE it
(`docs/OPEN_QUESTIONS.md` §46a), so what passes is OUR choice of carrier and
not the provider refusing the alternative. The day the emulator enforces the
window, that run gets stronger without changing.

## The sandbox payer

With a test key, the debtor is `POST /v1/test/charges/{chargeId}/pay` (alias `POST /v1/charges/{chargeId}/sandbox/pay`): the charge goes through the same settlement path a provider `charge-in` webhook takes, `commerce.charge.paid` fans out to the project's triggers, and every record carries `simulated: true` and `settled_against: "sandbox_fixture"`. No money moves anywhere. The kit calls it only when a scenario says `payer: pays` or you pass `--simulate-payer`. In the CI the payer is the fixture inside the stub rail (`packages/agent-core/src/stubs/charge-rail.ts`).

## What is sandbox, what the agent applies alone, what is out

Read from `agent.yaml`, field `maturity`:

| Capability | Maturity | Meaning |
|---|---|---|
| `bolepix-receivables` | sandbox | Cobranca com vencimento through the CodeSpar sandbox, paid by the sandbox payer. No real money. |
| `receipt-verification` | blocked | Ed25519 landed on the API's payment receipts, and this agent mints none: the API still seals no record for a paid charge, so what the bundle keeps is the paid charge as the API reports it, marked `kind: "charge"`, with no chain and no signature to check. |

What the agent applies on its own (`guardrails.json`): the envelope (15% maximum discount, up to 3 instalments, due dates within 90 days, R$ 50,00 minimum instalment, collection hours 08:00–20:00 in America/Sao_Paulo), the escalation threshold (R$ 3.000,00 per agreement in `mandate`), and "the core's total wins" when the model states another.

Not in this kit yet: a policy signed by the API for the receiving side (section 16 of the spec, candidate to product), and a mandate born in the conversation (see the channel section below).

## Commands

| Command | Does |
|---|---|
| `npm start` | Interactive terminal. You are the payer; the operator's approval is asked on the same keyboard. |
| `npm start -- --input "oi, recebi a mensagem sobre o acordo do pedido 1042" [--approve] [--simulate-payer] [--wait 60] [--json] [--now <ISO>]` | One turn, no prompt. Without `ANTHROPIC_API_KEY` it replays the recorded scenario whose first turn is that input. `--json`: machine data on stdout, people on stderr (add npm's `-s` when piping). Exit code 3 when a receivable is still waiting. `--now 2026-09-23T14:00:00-03:00` pins the clock the guardrails read (collection hours `08:00-20:00`, the due-date window, every timestamp) instead of the wall clock; the CI gate passes it so the fixture is inside collection hours at any hour. `CODESPAR_AGENT_NOW` in the environment is the same pin and reaches every command (`approve`, `resume`, `poll`, `rerun`, `reconcile`); the flag wins when both are set. |
| `npm start -- --channel whatsapp [--scripted] [--conversation <name>] [--backend simulator\|cloud-api]` | The conversation channel. The default backend is the local emulator (`npm run whatsapp:emulator`, no Meta account and no credential); `--scripted` replays the debtor's turns from `channels/whatsapp/`. See [The WhatsApp channel](#the-whatsapp-channel). |
| `npm start -- --scenario <name> [--mode human\|mandate] [--rail stub\|api]` | A scenario pack from `scenarios/`. With `--rail api` and a test key the charge, the poll and the sandbox payer are real, and `cycle_seconds` is measured. |
| `npm run check` | The manifest gate: fails if the prompt, tools or guardrails contradict `agent.yaml`, if `AGENTS.md` and `CLAUDE.md` differ, or if `mcp`, `cli` or `schema` are missing. |
| `npm run eval` | The adversarial suite (`evals/adversarial/`) and every scenario in every mode, on the replay provider and the stub rail. |
| `npm run approve <execution-id>` / `npm run deny <execution-id>` | The operator's decision as its own command: decides an execution left in `awaiting_approval`, writes the section 4.2 artifact, runs it through the same last gate `npm start` uses, and waits for the payer (`--wait`, `--simulate-payer`). |
| `npm run poll [--wait <s>] [--simulate-payer] [--payer pays\|expires\|never]` | Keeps looking at every receivable still waiting for its payer. Shows an instrument not shown yet, tells the payer the outcome once, fetches the paid record. `--payer` scripts the stub's fixture, which is how "nobody paid and it expired" is reachable at all: a due date passes between two runs, never inside one. |
| `npm run poll -- --channel whatsapp --conversation <name>` | The same, back in the conversation. Free-form while the 24-hour window is open, an approved template once it has shut. Nothing waiting is a clean no-op; polling twice tells the person once. See [Agreed on Tuesday, paid on Friday](#agreed-on-tuesday-paid-on-friday). |
| `npm run webhook [--port 8787] [--secret <trigger secret>]` | The receiving end of a trigger delivery, on localhost. A stub: you register the trigger and expose the URL. |
| `npm run resume` | After a crash: dispatches only what the outbox proves was never sent, reconciles the rest from the rail. Never issues twice. |
| `npm run rerun <run-id>` | Replays a recorded run with no network and checks the state sequence matches; the payer's behaviour (paid, expired) is read from the recording. |
| `npm run reconcile` | Compares local state with the rail. One look, read-only; names what is waiting for a payer, what is uncertain, what record is missing locally. |
| `npm run inspect <run-id> [--json] [--html <file>]` | The proof bundle of that run read back as a timeline: who proposed what, who approved it and when (with the `items_hash` and the escalation trigger when one fired), under which version of the mandate, every state transition with its actor, which call went out under which idempotency key, what the rail answered, and which receipts came back. `--json` puts the whole report on stdout and nothing else; `--html` writes one self-contained page that opens from disk with nothing fetched. Payees are masked the way the bundle masks them, and the conversation is reported as counts, not text. |

## The proof bundle

Every run writes `runs/<run-id>/`:

```
transcript.jsonl        the conversation and the tool calls
approval.json           the approval artifacts of the run (section 4.2 of the spec)
mandate.snapshot.json   the collection policy as it was, debtors' documents masked
events.jsonl            every transition, every look, every charge event, every message to the payer, each with its actor
receipts/               the paid charges as the API reports them, each stamped with the actor (kind: charge, unsealed)
run.json                mode, rail, policy id and the version it ran under
```

No key and no secret is written there. Documents are masked; the payer's document is never in a message.

`verify.json` is the one file section 11 names and this repository does not
write: it is the output of `codespar audit replay`, which is not a registered
command of `@codespar/cli`, and the spec forbids a second implementation of
the hash-chain check. `npm run inspect` says so in as many words instead of
leaving the absence to be guessed at.

Read the bundle back with `npm run inspect <run-id>`: the negotiated terms,
who approved them, each receivable the rail accepted, the instrument the payer
was shown as it became payable, and what closed the cycle.

## Limits and stubs

- A policy for the receiving side, signed by the organization, does not exist in the API; the collection policy is the merchant's own file (`mandate.example.json`, in the shape of the consumer mandate, where the named entries are the debtors with an open agreement) and the envelope is the kit's code. Candidate to product (section 16 of the spec).
- The approval artifact is signed by HMAC with a **local development key** (`.codespar/approval.key`). This is a stub: the CodeSpar API does not sign approval lists today. It proves what was approved to whoever runs the agent.
- The API seals no record for a paid charge. The bundle keeps the paid charge as the API reports it, with `simulated: true` when the sandbox payer paid it. Nothing here is proof to anyone outside the merchant.
- Revocation and the kill switch run against a **local stub** (`LocalMandateStatusStub` in `packages/agent-core/src/stubs/mandate-status.ts`); the collection policy has no API-side status to read.
- The `actor` of every call is carried locally on every event, approval and record copy. The API has no `actor` field on the wire today.
- Collection over WhatsApp has rules: hours, secrecy of the debt, no embarrassment, LGPD. Two of them are decidable and are code above the channel, on every backend: nothing is sent outside the collection hours, a message goes to the bound contact and to no other number, a message may not name another debtor's agreement, and a CPF or CNPJ in a message is refused. The other two are the prompt's and the operator's: no code reads a sentence and tells whether it shames somebody.
- CodeSpar does not host or run this agent. The repository delivers it; whoever runs it, runs it.
- What the agent issues inside the policy was authorized by the merchant, and the approval artifact proves what. The split of loss between partner, institution and CodeSpar on an authorized but wrong receivable is contractual and not yet written.

## Going to production

Swap the `csk_test_` key for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the debtors' book (your ERP instead of `src/agreements.ts`), the webhook endpoint for `commerce.charge.*` (or keep the poll), the payer (a real person, not the sandbox route). What does not: the code, `agent.yaml`, the `approval` key, the envelope.
