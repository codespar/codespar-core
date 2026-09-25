# {{name}}

Scaffolded by `codespar init --template supplier-payments-agent` from the `supplier-payments-agent` starter kit
(https://github.com/codespar/agent-starter-kits at `8f130b7cdc30510c929e6f7ebb07184f763e6ce4`, agent 0.1.0).

A company delegates its suppliers, commissions and payroll to an agent that pays them in batches under one signed mandate. A batch is a loop of executions: one refusal does not stop the others, and re-running it pays nobody twice.

`@codespar/agent-core` and `@codespar/agent-runtime` are not published on npm, so the copies this agent was built
against are vendored here and linked as npm workspaces; the agent's own
`package.json` pins resolve to them unchanged:

  - `packages/agent-core/` — @codespar/agent-core 0.1.0
  - `packages/agent-runtime/` — @codespar/agent-runtime 0.1.0

```
  cp agents/supplier-payments-agent/.env.example agents/supplier-payments-agent/.env   # then fill in your keys
  npm install
  npm start
```

The agent's guide is [`agents/supplier-payments-agent/README.md`](agents/supplier-payments-agent/README.md); its commands run at this root
(`npm run check`, `npm run eval`, `npm test`) or inside `agents/supplier-payments-agent/`. The manifest pins
`cli: "@codespar/cli@0.14.0"`, the CLI version whose `agent run`/`eval` this agent was written for.
