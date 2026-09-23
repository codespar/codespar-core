# {{name}}

Scaffolded by `codespar init --template bills-agent` from the `bills-agent` starter kit
(https://github.com/codespar/agent-starter-kits at `778223274a5df3521d9ef9f33a21446868482391`, agent 0.1.0).

The consumer delegates the month's bills to an agent that pays under a signed mandate: per-payment cap, monthly cap, named payees, expiry. Every payment returns a receipt.

`@codespar/agent-core` is not published on npm yet, so the copy this agent was built
against (0.1.0) is vendored under `packages/agent-core/` and linked as an npm workspace;
the agent's own `package.json` pin resolves to it unchanged.

```
  cp agents/bills-agent/.env.example agents/bills-agent/.env   # then fill in your keys
  npm install
  npm run consent -- --yes
  npm start
```

The agent's guide is [`agents/bills-agent/README.md`](agents/bills-agent/README.md); its commands run at this root
(`npm run check`, `npm run eval`, `npm test`) or inside `agents/bills-agent/`. The manifest pins
`cli: "@codespar/cli@0.13.0"`, the CLI version whose `agent run`/`eval` this agent was written for.
