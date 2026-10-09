# {{name}}

Scaffolded by `codespar init --template checkout-agent` from the `checkout-agent` starter kit
(https://github.com/codespar/agent-starter-kits at `d50c3d2fbb8707a4de67a6f8db5ee0bfb1b33794`, agent 0.1.0).

The merchant's agent that sells in the conversation: the customer builds a cart the code prices, the attendant (or the sales policy) confirms the order, one bolepix is issued with an idempotency key, the QR and the copy-and-paste go to the customer, and the order closes on commerce.charge.paid.

`@codespar/agent-core` and `@codespar/agent-runtime` are not published on npm, so the copies this agent was built
against are vendored here and linked as npm workspaces; the agent's own
`package.json` pins resolve to them unchanged:

  - `packages/agent-core/` — @codespar/agent-core 0.1.0
  - `packages/agent-runtime/` — @codespar/agent-runtime 0.1.0

```
  cp agents/checkout-agent/.env.example agents/checkout-agent/.env   # then fill in your keys
  npm install
  npm start
```

The kits root scripts this agent's channels use are carried too, verbatim, and
run at this root as they do in the kits repo:

  - `npm run whatsapp:emulator` — `scripts/whatsapp-emulator.mjs`

The agent's guide is [`agents/checkout-agent/README.md`](agents/checkout-agent/README.md); its commands run at this root
(`npm run check`, `npm run eval`, `npm test`) or inside `agents/checkout-agent/`. The manifest pins
`cli: "@codespar/cli@0.18.1"`, the CLI version whose `agent run`/`eval` this agent was written for.
