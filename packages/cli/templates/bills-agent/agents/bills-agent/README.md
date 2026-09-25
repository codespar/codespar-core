# bills-agent

[![rail: pix-out](https://img.shields.io/badge/rail-pix--out-2E8B57)](agent.yaml) [![maturity: sandbox](https://img.shields.io/badge/maturity-sandbox-orange)](agent.yaml) [![approval: human | mandate](https://img.shields.io/badge/approval-human_%7C_mandate-555)](agent.yaml) [![clone → receipt: 77 s](https://img.shields.io/badge/clone_%E2%86%92_receipt-77_s-8A2BE2)](#quickstart)

An agent that pays a household's monthly bills (school, groceries, the cleaner, utilities) over Pix, inside a mandate the account holder signs once: a cap per payment, a cap per month, named payees, one year of validity. It drafts each payment, a person approves it (or the mandate covers it), and every payment returns a receipt. Terminal for now; WhatsApp later.

## Quickstart

Node 22.13+ and a sandbox key (`csk_test_...`) from [codespar.dev/auth/signup](https://codespar.dev/auth/signup). No money moves.

```sh
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/bills-agent/.env.example agents/bills-agent/.env   # paste your csk_test_ key
npm install                                                  # at the repo root, not inside agents/bills-agent
npm run consent -- --yes                                     # sign the mandate once
npm start
> pague a escola de outubro
```

The run ends with `recibo: runs/<run-id>/receipts/rcpt_....json`. Last timed run (staging, 2026-09-23): 77 seconds from `git clone` to a receipt the API confirmed.

- `ANTHROPIC_API_KEY` can stay empty: the agent then replays the recorded happy path. The old placeholder `sk-ant-your_key_here` counts as empty.
- One-shot form: `npm start -- --input "pague a escola de outubro" --approve`. It needs the consent first and stops at `no signed mandate yet` otherwise; the interactive `npm start` runs the consent on its own.
- Staging key: uncomment `CODESPAR_API_URL=https://api.staging.codespar.dev` in `.env` before the consent. A production key needs nothing else.
- `npm start` and `npm run consent` at the root drive this agent. Inside `agents/bills-agent` the same scripts work once the root is installed.
- Scaffold instead of cloning: `npx -y @codespar/cli@0.14.0 init my-agent --template bills-agent`, then the same `.env`, install and consent inside `my-agent/`.

Check the receipt against the API (a staging key also needs `--base-url "$CODESPAR_API_URL"`):

```sh
set -a; . agents/bills-agent/.env; set +a
npx -y @codespar/cli@0.14.0 consumers get-receipts rcpt_...   # GET /v1/consumers/receipts/{id}; expect sandbox: true, money_moved: false
```

## What it shows

| Contract | How |
|---|---|
| The model proposes, the code executes | `codespar_pay` creates an execution in `drafted`. Only `ExecutionEngine` in `@codespar/agent-core` checks mandate, caps, allowlist, `escalate_above` and `items_hash`, and only it reaches `executing`. |
| Two modes, one trail | `approval: human` (default): the account holder approves each payment in the terminal. `approval: mandate`: the agent runs alone inside the signed allowance and asks above `escalate_above`. Same code, same states, same receipts. |
| Approval that matches | Nothing reaches `executing` without an approval artifact whose `items_hash` equals the list about to be executed. Recomputed at execution time. |
| Readable refusal | Cap per payment, cap per month, payee outside the mandate, revoked mandate, outside hours: each names itself in the trail and in the chat. |
| Survives a restart | Kill the process in `executing`, run `npm run resume`: one payment, one receipt. |
| Sandbox by construction | A key that does not start with `csk_test_` fails before any network call. |

## What is sandbox, what the agent applies alone, what is out

Read from `agent.yaml`, field `maturity`:

| Capability | Maturity | Meaning |
|---|---|---|
| `pix-out` | sandbox | Pix payments through the CodeSpar sandbox. No real money. |
| `embedded-consent` | sandbox | The mandate starts from a consent the account holder authorizes; in the sandbox the kit runs the partner surface in the terminal. |
| `receipt-verification` | sandbox | Every receipt sealed since the API added Ed25519 carries a signature anybody can check against the published key set: `npm run verify -- runs/<run-id>/receipts/<id>.json`. Receipts sealed before that carry none and never will. |

What the agent applies on its own, before the mandate (`guardrails.json`): the escalation thresholds (R$ 1.500,00 per payment, first payment to each payee, 22:00–07:00), a 24-hour velocity window per payee against fractioning, and "the core's total wins" when the model states another.

Not in this kit yet: WhatsApp, batch payouts.

## Commands

| Command | Does |
|---|---|
| `npm start` | Interactive terminal. With a test key and no mandate yet, runs the consent first (partner surface: you are the account holder at the keyboard). The `--input` form below does not: it needs `npm run consent -- --yes` before it. |
| `npm start -- --input "pague a escola de outubro" [--approve] [--json] [--now <ISO>]` | One turn, no prompt. `--json`: machine data on stdout, people on stderr. Without `ANTHROPIC_API_KEY` (empty, or still the `.env.example` placeholder) it replays the recorded happy-path. To pipe the JSON, add npm's `--silent` (`npm start -s -- --input ... --json \| jq .`): npm itself prints the script banner on stdout. `--now 2026-09-23T14:00:00-03:00` pins the clock the guardrails read (`escalate_above.outside_hours`, `22:00-07:00`, and every timestamp) instead of the wall clock, so a run near 22:00 is reproducible; `CODESPAR_AGENT_NOW` in the environment is the same pin and reaches every command (`approve`, `resume`, `rerun`, `reconcile`); the flag wins when both are set. |
| `npm start -- --scenario <name> [--mode human\|mandate]` | A scenario pack from `scenarios/`. |
| `npm run check` | The manifest gate: fails if the prompt, tools or guardrails contradict `agent.yaml`, if `AGENTS.md` and `CLAUDE.md` differ, or if `mcp`, `cli` or `schema` are missing. |
| `npm run eval` | The adversarial suite (`evals/adversarial/`) and every scenario in every mode, on the replay provider. |
| `npm run approve <execution-id>` / `npm run deny <execution-id>` | The human decision of `human` mode, as its own command: decides an execution left in `awaiting_approval` (a `--input` run without `--approve`, a restart), writes the section 4.2 artifact and runs it through the same last gate `npm start` uses. |
| `npm run resume` | After a crash: dispatches only what the outbox proves was never sent, reconciles the rest from the rail, expires what went stale. Never pays twice. |
| `npm run rerun <run-id>` | Replays a recorded run with no network and checks the state sequence matches. |
| `npm run inspect <run-id> [--json] [--html <file>]` | The proof bundle of that run read back as a timeline: who proposed what, who approved it and when (with the `items_hash` and the escalation trigger when one fired), under which version of the mandate, every state transition with its actor, which call went out under which idempotency key, what the rail answered, and which receipts came back. `--json` puts the whole report on stdout and nothing else; `--html` writes one self-contained page that opens from disk with nothing fetched. Payees are masked the way the bundle masks them, and the conversation is reported as counts, not text. |
| `npm run verify -- <receipt-file> [--json] [--keys <file>] [--url <url>]` | Checks a receipt's Ed25519 signature against CodeSpar's published key set. No key and no agent needed: it runs on a receipt file copied to another machine. The exit code is the verdict — 0 verified, 1 tampered, 3 unsigned, 4 unknown key, 5 the key set could not be read, 6 not a receipt. |
| `npm run reconcile` | Compares local state with the rail. Closes an `executing` execution only from a recorded rail outcome; what the rail has not answered yet stays `executing` with an `execution.uncertain` event, for a human. Never dispatches. |
| `npm run consent -- --yes` | Runs a new consent for a mandate (test key, partner surface); without `--yes` it asks at the keyboard. The signed envelope is stored in `.codespar/mandate.json`, mode 0600. The first thing to run after `.env`: `npm start -- --input` needs it. |

The same through the CLI `agent.yaml` pins (`cli: "@codespar/cli@0.14.0"`; the lines match its `--help`):

| Command | Does |
|---|---|
| `npx -y @codespar/cli@0.14.0 agent run agents/bills-agent --input "pague a escola de outubro" [--approve\|--deny]` | The same as `npm start -- --input ...`, through the agent's own `npm start`; without `--input`, the interactive terminal. |
| `npx -y @codespar/cli@0.14.0 eval agents/bills-agent` | `npm run check` plus the eval suite; exit 1 on any failing case. |
| `npx -y @codespar/cli@0.14.0 mandate revoke <mandate-id> [--reason <text>]` | Revokes a mandate against the API (`active` or `paused` → `revoked`, terminal). The next gate of every open execution answers `mandate_revoked`. |

## The proof bundle

Every run writes `runs/<run-id>/`:

```
transcript.jsonl        the conversation and the tool calls
approval.json           the approval artifacts of the run (section 4.2 of the spec)
mandate.snapshot.json   the mandate as it was, keys masked
events.jsonl            every transition and every rail event, each with its actor
receipts/               the receipts the rail returned, each stamped with the actor
run.json                mode, rail, mandate id and the version it ran under
```

No key and no secret is written there. Payee keys are masked.

`verify.json` is the one file section 11 names and this repository does not
write: it is the output of `codespar audit replay`, which is not a registered
command of `@codespar/cli`, and the spec forbids a second implementation of
the hash-chain check. `npm run inspect` says so in as many words instead of
leaving the absence to be guessed at.

Read the bundle back with `npm run inspect <run-id>`.

The receipt copies carry both of the API's seals. `receipt_sig` is the HMAC, which proves the payment to whoever runs this agent; `receipt_sig_ed25519` and `receipt_sig_kid` are the asymmetric half, which proves it to anybody:

```sh
npm run verify -- runs/<run-id>/receipts/<receipt-id>.json
```

That reads the public key set from `/.well-known/codespar-receipt-keys.json`, picks the key the receipt names, rebuilds `codespar-receipt:v1:<receipt_id>:<chain>` and checks it with stock `node:crypto` — no key, no API key, no CodeSpar call that could be refused. `--keys <file>` uses a saved copy of the key set instead and touches no network at all; `--json` puts the verdict on stdout. `--url` names another deployment's key set: the default is production, and every deployment publishes its own key under the same `kid`, so a sandbox receipt checked against the production keys reads `tampered`. The signature covers the receipt id and the chain, so the masking above does not disturb it, and the file verifies on a machine that has never seen this repository. A receipt sealed before the API had the capability answers `unsigned`, which is not a failure: it has no Ed25519 signature and never will, and its HMAC seal is unaffected.


## Limits and stubs

- The receipt carries two signatures. The HMAC one, under the consumer secret CodeSpar holds, proves the payment to whoever runs this agent, because verifying it means holding the key that also mints it. The Ed25519 one, sealed by CodeSpar's platform issuer key since the API added it, proves it to anybody with `npm run verify`. A receipt sealed before that carries no Ed25519 signature and never will — there is no backfill, and signing an old receipt with today's key would attest to what the database says now, not to what happened then.
- The approval artifact is signed by HMAC with a **local development key** (`.codespar/approval.key`). This is a stub: the CodeSpar API does not sign approval lists today. It proves what was approved to whoever runs the agent.
- Revocation is checked against the API. With a test key, the core reads `GET /v1/mandates/{id}` before every `executing` and executes on `status: active` only: `paused` → `denied` (`mandate_paused`), `revoked` → `denied` (`mandate_revoked`), `expired` → `expired`, and a read that does not answer (timeout, 5xx, 404, an unreadable body) → `denied` (`mandate_status_unavailable`), never "assume active". `npx -y @codespar/cli@0.14.0 mandate revoke <id>` is the switch. Without a key (the CI, the scenarios, `rerun`) the same check answers from a **local stub** (`packages/agent-core/src/stubs/mandate-status.ts`), which is also where the organization kill switch (`org pauseAll`) lives, since the API does not expose one yet.
- The `actor` of every call is carried locally on every event, approval and receipt copy. The API has no `actor` field on the wire today; the spend carries `agent_id`, which the mandate binds.
- A `consumer_id` with an approved account does not leave the registry. Synthetic onboarding stops at document verification, which is the correct behaviour.
- CodeSpar does not host or run this agent. The repository delivers it; whoever runs it, runs it.
- What the agent executes inside the mandate was authorized by the account holder, and the approval artifact proves what. The split of loss between partner, institution and CodeSpar on an authorized but wrong payment is contractual and not yet written.

## Going to production

Swap the `csk_test_` key for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the approved `consumer_id`, the webhook endpoint. What does not: the code, `agent.yaml`, the `approval` key.
