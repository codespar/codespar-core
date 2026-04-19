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

## Configuration

Resolution order (first match wins):

1. Command-line flags (`--api-key`, `--base-url`)
2. Environment variables (`CODESPAR_API_KEY`, `CODESPAR_BASE_URL`)
3. Config file at `~/.codespar/config.json` (chmod 600)

## Templates

| Slug | Stack |
|------|-------|
| `pix-agent` | Node + OpenAI — minimal Pix charge + WhatsApp notify |
| `ecommerce-checkout` | Node + Claude — full Complete Loop |
| `streaming-chat` | Next.js + Vercel AI — token-by-token streaming |
| `multi-tenant` | Next.js + OpenAI — one API key, N tenants |

## Need more?

For production workloads with governance, audit trails, policy engines, self-hosted runtimes, and enterprise commerce primitives (mandates, escrow, payment routing), see **[CodeSpar Enterprise](https://codespar.dev/enterprise)**.

## License

MIT — [codespar.dev](https://codespar.dev)
