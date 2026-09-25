# @codespar/cli

Command-line interface for CodeSpar — authenticate, browse servers, execute tools, manage sessions, stream logs, and scaffold projects from your terminal.

## Install

```bash
npm install -g @codespar/cli
```

## Usage

```bash
# Authenticate (stores API key in ~/.codespar/config.json)
codespar login

# Browse the catalog
codespar servers list
codespar tools list --server asaas

# Run a single tool call
codespar execute codespar_pay \
  --server asaas \
  --input '{"method":"pix","amount":15000,"currency":"BRL"}'

# Give an agent a unified multi-currency wallet under ONE signed mandate:
# a Pix (BRL) slot and a USDC slot, each with its own per-currency cap. No FX.
codespar mandate create --consumer shopper --agent buyer \
  --payee https://x402.codespar.dev/api/market-data,11144477735 \
  --slot BRL:pix:50000:1500 \
  --slot USDC:usdc:100:100

# See the wallet, rolled up per currency
codespar wallet shopper

# The same mandate pays a 402-protected API in USDC (gated by the USDC per-tx cap)
codespar spend --mandate <id> --amount 1 --agent buyer \
  --payee https://x402.codespar.dev/api/market-data

# Move value between slots (per-currency, no FX — a cross-currency move is a real
# ramp trade at the real rate). Omit --execute to just plan it.
codespar transfer shopper --from BRL --to USDC --amount 15000

# Every published meta-tool is invocable by name; the actions come from the
# published definition, so an unknown one is refused before anything is sent
codespar tools meta
codespar tool codespar_wallet --action balance --arg consumer_id=con_0000
codespar pay --action status --arg reference=pay_0000

# Resource groups are derived from the served OpenAPI document: each
# subcommand is one operation, its path parameters are the positionals
codespar sellers status slr_0000
codespar wallets list --query status=active
codespar triggers create --input '{"url":"https://example.test/hook","events":["payment.settled"]}'
codespar boletos list con_0000

# Manage sessions and logs
codespar sessions list
codespar logs tail --server stripe

# Scaffold a new agent
codespar init my-agent
```

## Commands

| Command | Description |
|---------|-------------|
| `login` | Save API key to `~/.codespar/config.json` |
| `logout` | Clear the stored API key |
| `whoami` | Show authenticated user, org, project, and scopes |
| `servers list` | List servers (filter by `--category`, `--region`) |
| `servers show <id>` | Show a server's details and tools |
| `tools list` | List tools (filter by `--server`) |
| `tools show <name>` | Show a tool's full input/output schema |
| `tools meta [name]` | The 15 published meta-tool definitions — actions, required input, vocabularies |
| `tool <name>` | Invoke any published meta-tool: `--action`, `--arg key=value`, `--input` |
| `pay` / `kyc` | Shorthand for `tool codespar_pay` / `tool codespar_kyc` |
| `consumers <sub>` | Consumers: profile, Pix keys, Pix lookups, receipts, contact verification |
| `boletos <sub>` | DDA: subscribe a document, list the boletos it receives |
| `sellers <sub>` | Sellers: onboarding status, custody, pending settlement, ledger |
| `mcp-servers <sub>` | Tenant MCP servers: register, validate, patch a tool, sweep platform fees |
| `wallets <sub>` | Wallets: balances, ledger, funding sources, execute, transfer, custody |
| `triggers <sub>` | Triggers (webhooks): endpoints, deliveries, DLQ, secret rotation, redelivery |
| `execute <tool>` | Run a single tool call in a throwaway session |
| `discover <query>` | Search the catalog for tools matching a use case |
| `agent run <dir>` | Run one turn of an agent directory built on `@codespar/agent-core` (`--input`, `--approve`/`--deny`) through its own `npm start`; same output, same exit code |
| `eval <dir>` | Run the agent's `npm run check` + `npm run eval` (adversarial suite and scenarios), one line per case; exit 1 on any failure |
| `mandate create` | Create a consumer mandate — the agent's allowance. `--slot CURRENCY:METHOD:CAP:PER_TX` (repeatable, e.g. `BRL:pix:50000:1500`) for a unified multi-currency wallet; per-currency caps, no FX |
| `mandate revoke <id>` | Revoke a consumer mandate (`POST /v1/mandates/{id}/revoke`); active or paused → revoked, terminal. `--reason` goes to the evidence row |
| `wallet <consumer>` | Show the consumer's unified wallet, rolled up per currency |
| `transfer <consumer>` | Move value between wallet slots (`--from --to --amount [--execute]`); a cross-currency move is a real ramp trade at the real rate, no FX |
| `spend` | Execute an agentic spend against a mandate (x402 / USDC / Pix, routed by payee) |
| `charge` | Issue an inbound charge via `codespar_charge` |
| `ship` | Generate label / quote rates / track via `codespar_ship` |
| `ledger` | Post entries / read balances / create accounts via `codespar_ledger` |
| `issue` | Issue / freeze / read agent spend cards via `codespar_issue` |
| `payment-status <id>` | Poll async settlement status (add `--stream`) |
| `verification-status <id>` | Poll async KYC status (add `--stream`) |
| `wizard [server]` | Connection wizard — required secrets, connect URL, next steps |
| `sessions list` | List recent sessions (filter by `--status`, `--limit`) |
| `sessions show <id>` | Show session details (add `--logs` for tool calls) |
| `sessions close <id>` | Close an active session |
| `connect list` | List active Connect Links per user |
| `connect start <server>` | Start an OAuth Connect Link flow (add `--open`) |
| `connect revoke <server>` | Revoke a connection |
| `logs tail` | Stream tool-call logs in real time (SSE) |
| `audit replay` | Ask the API whether the audit chain is verified over an interval (`--from`/`--to`, ISO 8601) and render the verdict; the chain check runs server-side, exit 1 when the verdict is not `verified` |
| `init <name> [--template <slug>]` | Scaffold a new commerce agent from a template; `init --list` shows them |

## Global flags

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output (pipe into `jq`) |
| `--api-key <key>` | Override the stored key |
| `--base-url <url>` | Point at a custom API (staging, self-hosted) |
| `--project <id>` | Scope requests to a project (multi-project orgs) |

Resource-group subcommands also take `-q, --query key=value` (repeatable),
`--timeout <ms>`, and — when the operation declares a request body —
`-i, --input '<json>'` or `-f, --input-file <path>`.

## Where the commands come from

The resource groups and the meta-tool commands are not written one by one.
`codespar sellers`, `consumers`, `boletos`, `mcp-servers`, `wallets` and
`triggers` are derived from `API_OPERATIONS` — the operation table
`@codespar/sdk` generates from the served OpenAPI document — so a
subcommand is one operation, and the request behind it is the one the
document declares. `codespar tool <name>` reads the 15 shared meta-tool
definitions from `@codespar/types`: the names, the actions and the
required input are the published ones, checked before anything is sent.

A resource family with no command needs a written exception with a date
(`src/surface.ts`), and the coverage test refuses to let that list grow.

## Configuration

Resolution order (first match wins):

1. Command-line flags (`--api-key`, `--base-url`, `--project`)
2. Environment variables (`CODESPAR_API_KEY`, `CODESPAR_BASE_URL`, `CODESPAR_PROJECT`)
3. Config file at `~/.codespar/config.json` (chmod 600)

## Templates

`codespar init --list` prints this table from the package itself, with a
one-line description per template.

| Slug | Stack |
|------|-------|
| `pix-agent` | Node + OpenAI — minimal Pix charge + WhatsApp notify |
| `ecommerce-checkout` | Node + Claude — full Complete Loop |
| `streaming-chat` | Next.js + Vercel AI — token-by-token streaming |
| `multi-tenant` | Next.js + OpenAI — one API key, N tenants |
<!-- kit-templates:start -->
| `bills-agent` | Starter kit — The consumer delegates the month's bills to an agent that pays under a signed mandate: per-payment cap, monthly cap, named payees, expiry. Every payment returns a receipt. |
| `collections-agent` | Starter kit — The merchant's agent that collects: agrees terms with the payer inside a negotiation envelope, issues one bolepix per instalment with an idempotency key, presents the QR and the copy-and-paste in the conversation, and closes the cycle on commerce.charge.paid or commerce.charge.expired. |
| `hello-agent` | Starter kit — The worked example of the codespar-agent-builder skill: a read-only agent that reads the month's bills and cannot pay. Built from the five files, the packs and one kit module. |
| `supplier-payments-agent` | Starter kit — A company delegates its suppliers, commissions and payroll to an agent that pays them in batches under one signed mandate. A batch is a loop of executions: one refusal does not stop the others, and re-running it pays nobody twice. |
<!-- kit-templates:end -->

The kit rows between those markers are written by `npm run sync:kit-templates`
from each agent's own `description`. Do not edit them by hand: the next sync
overwrites them, which is the point — a hand-kept list goes stale on the next
agent that lands.

### Starter-kit templates

The kit templates are the agents of
[codespar/agent-starter-kits](https://github.com/codespar/agent-starter-kits),
copied into this package at release time — every agent the synced ref carries,
discovered rather than listed, which is why the table above is generated. `init`
never fetches them: what it scaffolds is what the published tarball carries, so
it works offline and two installs of the same CLI version scaffold the same
bytes.

```
codespar init my-bills --template bills-agent
cd my-bills
cp agents/bills-agent/.env.example agents/bills-agent/.env   # then fill in your keys
npm install
npm run consent -- --yes
npm start
```

The scaffold mirrors the kits repository: `agents/<name>/` and the kits-local
packages that agent needs are the kits' own files, byte for byte, under a
generated root `package.json` that links them as npm workspaces. None of those
packages is published on npm — `@codespar/agent-core` and, since the runner was
split out of it, `@codespar/agent-runtime`, which owns the `codespar-agent` bin
every agent script calls — so they travel vendored and the agent's own pins
resolve to those copies exactly as they do in the kits repository. Which ones to
vendor is walked from the agent's dependencies, transitively, and a build that
would leave one behind is refused rather than shipped: a pin with no directory
behind it sends `npm install` to the registry for a package that was never
published there. Nothing inside the kit is rewritten: `agent.yaml` keeps the
kits' `cli:` and `mcp:` pins, and every relative path
(`../../tsconfig.base.json`, the `.env` the agent reads from its own directory,
the paths its README names) keeps resolving.

The template's own root scripts are narrowed to the one agent, and its `check`
is deliberately NOT the kits root's: the kits root runs repo-level gates over
files a single-agent template does not carry.

`templates/kits.lock.json` records which kits ref was synced (tag or commit),
the commit it resolved to, and a content hash per template. The release gate
(`npm run check:kit-templates`, run in CI and in the publish workflow)
fetches that ref again, rebuilds the templates and fails if the packaged
trees differ from the lock by a byte — a hand-edited template or a lock
bumped without a sync does not ship.

**To bump the kits** to a new tag or commit, from `packages/cli`:

```
npm run sync:kit-templates -- --ref <tag-or-sha>   # rewrites templates/<kit>/, the lock and the README rows
git add templates README.md && git commit
```

A bump can bring agents that did not exist before, so it can add templates; the
sync writes the table above and the lock, and `codespar init --list` reads the
lock. Run the e2e job (`CODESPAR_CLI_KIT_E2E=1`) on a bump: it is the only gate
that proves a freshly generated template still installs and passes its own
`npm run check`, for every template the lock names.

then bump this package's version (new template content is at least a minor).
Without `--ref` the sync re-runs at the locked ref, which is the way to
regenerate the trees after a change to the sync script itself.

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
