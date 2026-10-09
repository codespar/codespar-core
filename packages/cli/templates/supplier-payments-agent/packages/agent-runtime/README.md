# @codespar/agent-runtime

The runner every starter-kit agent shares. It is not published: it is a
workspace package the agents depend on, and it ships one binary,
`codespar-agent`, so an agent's `package.json` script is the command and
nothing else.

```json
"scripts": { "start": "codespar-agent start", "check": "codespar-agent check" }
```

## What it owns

- The terminal channel: the banner, the approval question, the transitions it
  prints, the receipt path.
- The WhatsApp channel (`src/channels/`): one adapter over two backends that
  are the SAME code with a different base URL — a local Cloud API emulator
  ([`dyvit-wa-sim`](https://github.com/fabianocruz/whatsapp-simulator), MIT,
  run at a pinned npm version by `npm run whatsapp:emulator`) and Meta's own
  host.
  `live` is derived from that host, which is what the consent-evidence builder
  refuses on. The rules live in the adapter, above both — the collection
  hours, the bound contact, the secrecy of the debt, the document rule, the
  24-hour session window — so choosing a backend changes who carries the bytes
  and nothing else. What an AGENT ships for this channel is the conversations
  and its template registry, under `agents/<name>/channels/whatsapp/`.
- `poll --channel whatsapp` comes back to a conversation the run that opened it
  has ended: it reads the window back from the bundle's `channel.jsonl` and
  confirms the outcome free-form while the 24 hours are open, as an approved
  template once they have shut.
- Every command: `start` (interactive, `--input`, `--scenario`, `--transcript`,
  `--json`, `--approve`/`--deny`, `--now`, `--channel`, `--backend`,
  `--conversation`, `--scripted`), `consent`, `approve`, `deny`, `resume`,
  `rerun`, `reconcile`, `inspect` (`--json`, `--html <file>`), `poll`
  (`--channel`, `--conversation`, `--backend`, `--wait`, `--simulate-payer`,
  `--payer`, `--now`, `--json`), `webhook`, `check`, `eval`, `verify`
  (`--from-api`, `--json`, `--keys`/`--url`, `--approval`), which needs no
  agent directory.
- What a report says about a settlement the API replayed: the terminal line
  "já estava pago", `replayed` on the executions of a paying agent's one-shot
  `--json`, and "replayed, not paid by this run" in `inspect`. The first two
  read agent-core's `isReplayedSettlement`; `inspect` reads the same mark from
  the bundle's rail answers (`docs/OPEN_QUESTIONS.md` §39c).
- What `verify` prints: the verdict, the chain it recomputed, the approval it
  matched and, off a body that bound, `sandbox` and `money_moved` as the chain
  sealed them. Nothing else of the API's read, which still carries
  `mandate.sig` (§47).
- Setup: the manifest, the guardrails, the tools file, the system prompt, the
  local state, the signer, the proof bundle, the provider (Anthropic with a
  real key, replay without one), and the pinned clock (`--now`,
  `CODESPAR_AGENT_NOW`), which also pins the `today` the list tools return.
- The locale of what the code prints (#64). `setup` resolves it once per run:
  `--locale`, else `locale:` in `agent.yaml`, else `pt-BR`, and records it in
  the bundle's `run.json`. The terminal's own lines come from agent-core's
  `CORE_STRINGS` and the kit's from `kit.strings`, both in that locale; the
  parsers do not change with it (`parseApproval`, `parseBatchGesture` read both
  languages whatever is shown). A command that tells an outcome later (`poll`,
  `webhook`, `approve`) tells the counterparty in the locale of the run that
  proposed it, and `poll --channel whatsapp` sends the template copy in the
  conversation's recorded language and refuses a `--locale` that disagrees.
  The model's reply language is a different thing, read per turn from what
  the person types.
- The section 9 adversarial runner and the section 12 scenario runner.
- The `csk_test_` guard and the `.env.example` placeholder rule.

## What an agent owns

Its five files (`agent.yaml`, `SYSTEM_PROMPT.md`, `tools.json`,
`guardrails.json`, `mandate.example.json`), its `scenarios/` and `evals/`, and
one optional module, `src/kit.ts`:

```ts
import { defineAgent, defaultKit } from "@codespar/agent-runtime";

export const agent = defineAgent(import.meta.url, {
  ...defaultKit,
  handlers: () => ({ list_bills: listBills }),
});
```

`AgentKit` (in `src/kit.ts`) is the whole seam: the rail adapter
(`buildRail`), the tool handlers, the `policyExtension`, the console words
(`strings`, one entry per locale, and `labels`, which holds what must not vary
by locale: who approves and the record kinds), what a one-shot prints as JSON, and — for an agent whose money comes IN — the
sandbox payer and the one message per outcome. An agent that declares none of
it gets `defaultKit`: the stub rail, the example mandate, no tools.

`npm run check` fails when a key of `kit.strings` or of `CORE_STRINGS` is
missing from one locale (`strings_incomplete`), so an English run never prints
`undefined` where a Portuguese one prints a word.

`defineAgent(import.meta.url, kit)` finds the nearest `agent.yaml` above the
module, which is what makes every path (`scenarios/`, `evals/`, `.codespar/`,
`runs/`) and every test-only environment variable (`BILLS_STATE_DIR`,
`COLLECTIONS_RUNS_DIR`) resolve per agent without the agent naming them.

## Its tests travel with it

`codespar init` copies this package, verbatim, into every template, so
`test/` here reads nothing outside it: no `scripts/`, no other agent. Two
tests that do need the starter-kits repository — the pinned WhatsApp emulator
(`test/whatsapp-emulator.integration.test.ts`) and the `check` rule for the
template fallback asked of the shipped agents
(`test/whatsapp-fallback-check.test.ts`) — live in that repository's root
`test/`, which a template does not carry, and
`test/templates-read-nothing-outside.test.ts` there refuses the next one that
tries to come back.
