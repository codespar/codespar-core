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
| `bills-agent` | Starter kit — the titular's agent pays the month's bills under a signed mandate (`@codespar/agent-core`) |
| `collections-agent` | Starter kit — the merchant's agent collects: bolepix per instalment, closes on paid/expired (`@codespar/agent-core`) |

### Starter-kit templates

`bills-agent` and `collections-agent` are the agents of
[codespar/agent-starter-kits](https://github.com/codespar/agent-starter-kits),
copied into this package at release time. `init` never fetches them: what it
scaffolds is what the published tarball carries, so it works offline and two
installs of the same CLI version scaffold the same bytes.

```
codespar init my-bills --template bills-agent
cd my-bills
cp agents/bills-agent/.env.example agents/bills-agent/.env   # then fill in your keys
npm install
npm run consent -- --yes
npm start
```

The scaffold mirrors the kits repository: `agents/<name>/` and
`packages/agent-core/` are the kits' own files, byte for byte, under a
generated root `package.json` that links them as an npm workspace.
`@codespar/agent-core` is not published on npm yet, so it travels vendored,
and the agent's own `"@codespar/agent-core": "0.1.0"` pin resolves to that
copy exactly as it does in the kits repository. Nothing inside the kit is
rewritten: `agent.yaml` keeps the kits' `cli:` and `mcp:` pins, and every
relative path (`../../tsconfig.base.json`, the `.env` the agent reads from
its own directory, the paths its README names) keeps resolving.

`templates/kits.lock.json` records which kits ref was synced (tag or commit),
the commit it resolved to, and a content hash per template. The release gate
(`npm run check:kit-templates`, run in CI and in the publish workflow)
fetches that ref again, rebuilds the templates and fails if the packaged
trees differ from the lock by a byte — a hand-edited template or a lock
bumped without a sync does not ship.

**To bump the kits** to a new tag or commit, from `packages/cli`:

```
npm run sync:kit-templates -- --ref <tag-or-sha>   # rewrites templates/<kit>/ and the lock
git add templates && git commit
```

then bump this package's version (new template content is at least a minor).
Without `--ref` the sync re-runs at the locked ref, which is the way to
regenerate the trees after a change to the sync script itself.

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
