# @codespar/cli

Command-line interface for [CodeSpar](https://codespar.dev) — authenticate, inspect servers, execute tools, and manage sessions from your terminal.

## Install

```bash
npm install -g @codespar/cli
```

Verify:

```bash
codespar --version
```

## Quick start

```bash
# One-time: authenticate with your API key
codespar login

# Inspect the catalog
codespar servers list
codespar servers show stripe
codespar tools list --server asaas
codespar tools show codespar_pay

# Run a one-shot tool call
codespar execute codespar_pay \
  --server asaas \
  --input '{"method":"pix","amount":15000,"currency":"BRL"}'

# Manage sessions
codespar sessions list
codespar sessions show ses_abc123 --logs
codespar sessions close ses_abc123
```

## Commands

| Command | What it does |
|---------|--------------|
| `login` | Save your API key to `~/.codespar/config.json` |
| `logout` | Clear the stored API key |
| `whoami` | Show authenticated user, org, project, and key scopes |
| `servers list` | List the server catalog (filter by `--category`, `--region`) |
| `servers show <id>` | Show a server's details and tools |
| `tools list` | List tools (filter by `--server`) |
| `tools show <name>` | Show a tool's full input/output schema |
| `execute <tool>` | Run a single tool call in a throwaway session |
| `sessions list` | List recent sessions (filter by `--status`, `--limit`) |
| `sessions show <id>` | Show session details (add `--logs` for tool calls) |
| `sessions close <id>` | Close an active session |

Every command supports:

- `--json` — machine-readable JSON output (pipe into `jq`)
- `--api-key <key>` — override the stored key
- `--base-url <url>` — point at a custom API (staging, self-hosted)

## Configuration

Resolution order (first match wins):

1. Command-line flags (`--api-key`, `--base-url`)
2. Environment variables (`CODESPAR_API_KEY`, `CODESPAR_BASE_URL`)
3. Config file at `~/.codespar/config.json` (chmod 600)

## Scripting

Output is valid JSON on stdout and human messages on stderr, so you can pipe cleanly:

```bash
# IDs of all servers that handle Pix
codespar servers list --json \
  | jq -r '.[] | select(.capabilities | contains(["pix"])) | .id'

# p95 latency of the last 100 stripe calls in a session
codespar sessions show ses_abc123 --logs --json \
  | jq '[.logs[] | select(.server == "stripe") | .duration_ms] | sort | .[95]'
```

Use `--json` explicitly when piping — the CLI defaults to tables in a TTY.

## Development

This package lives in the `codespar-core` monorepo.

```bash
# From repo root
npm install
npm run build --workspace @codespar/cli
npm run typecheck --workspace @codespar/cli

# Run the local build directly
node packages/cli/dist/index.js --help
```

## License

MIT © CodeSpar
