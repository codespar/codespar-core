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

# Give an agent a wallet with a mandate, then let it pay a 402-protected API
# (x402 micropayment in USDC on Base, gated by the per-tx cap)
codespar mandate create --consumer shopper --agent buyer \
  --payee https://x402.codespar.dev/api/market-data --cap 1000 --per-tx-cap 100
codespar spend --mandate <id> --amount 1 --agent buyer \
  --payee https://x402.codespar.dev/api/market-data

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
| `execute <tool>` | Run a single tool call in a throwaway session |
| `discover <query>` | Search the catalog for tools matching a use case |
| `mandate create` | Create a consumer mandate — the agent's allowance / spending limit |
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
| `init <name>` | Scaffold a new commerce agent from a template |

## Global flags

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output (pipe into `jq`) |
| `--api-key <key>` | Override the stored key |
| `--base-url <url>` | Point at a custom API (staging, self-hosted) |
| `--project <id>` | Scope requests to a project (multi-project orgs) |

## Configuration

Resolution order (first match wins):

1. Command-line flags (`--api-key`, `--base-url`, `--project`)
2. Environment variables (`CODESPAR_API_KEY`, `CODESPAR_BASE_URL`, `CODESPAR_PROJECT`)
3. Config file at `~/.codespar/config.json` (chmod 600)

## Templates

| Slug | Stack |
|------|-------|
| `pix-agent` | Node + OpenAI — minimal Pix charge + WhatsApp notify |
| `ecommerce-checkout` | Node + Claude — full Complete Loop |
| `streaming-chat` | Next.js + Vercel AI — token-by-token streaming |
| `multi-tenant` | Next.js + OpenAI — one API key, N tenants |

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
