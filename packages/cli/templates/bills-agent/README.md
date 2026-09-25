# {{name}}

Scaffolded by `codespar init --template bills-agent` from the `bills-agent` starter kit
(https://github.com/codespar/agent-starter-kits at `8f130b7cdc30510c929e6f7ebb07184f763e6ce4`, agent 0.1.0).

The consumer delegates the month's bills to an agent that pays under a signed mandate: per-payment cap, monthly cap, named payees, expiry. Every payment returns a receipt.

`@codespar/agent-core` and `@codespar/agent-runtime` are not published on npm, so the copies this agent was built
against are vendored here and linked as npm workspaces; the agent's own
`package.json` pins resolve to them unchanged:

  - `packages/agent-core/` — @codespar/agent-core 0.1.0
  - `packages/agent-runtime/` — @codespar/agent-runtime 0.1.0

```
  cp agents/bills-agent/.env.example agents/bills-agent/.env   # then fill in your keys
  npm install
  npm run consent -- --yes
  npm start
```

The agent's guide is [`agents/bills-agent/README.md`](agents/bills-agent/README.md); its commands run at this root
(`npm run check`, `npm run eval`, `npm test`) or inside `agents/bills-agent/`. The manifest pins
`cli: "@codespar/cli@0.14.0"`, the CLI version whose `agent run`/`eval` this agent was written for.
