# {{name}}

Scaffolded by `codespar init --template collections-agent` from the `collections-agent` starter kit
(https://github.com/codespar/agent-starter-kits at `8f130b7cdc30510c929e6f7ebb07184f763e6ce4`, agent 0.1.0).

The merchant's agent that collects: agrees terms with the payer inside a negotiation envelope, issues one bolepix per instalment with an idempotency key, presents the QR and the copy-and-paste in the conversation, and closes the cycle on commerce.charge.paid or commerce.charge.expired.

`@codespar/agent-core` and `@codespar/agent-runtime` are not published on npm, so the copies this agent was built
against are vendored here and linked as npm workspaces; the agent's own
`package.json` pins resolve to them unchanged:

  - `packages/agent-core/` — @codespar/agent-core 0.1.0
  - `packages/agent-runtime/` — @codespar/agent-runtime 0.1.0

```
  cp agents/collections-agent/.env.example agents/collections-agent/.env   # then fill in your keys
  npm install
  npm start
```

The agent's guide is [`agents/collections-agent/README.md`](agents/collections-agent/README.md); its commands run at this root
(`npm run check`, `npm run eval`, `npm test`) or inside `agents/collections-agent/`. The manifest pins
`cli: "@codespar/cli@0.14.0"`, the CLI version whose `agent run`/`eval` this agent was written for.
