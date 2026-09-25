# {{name}}

Scaffolded by `codespar init --template hello-agent` from the `hello-agent` starter kit
(https://github.com/codespar/agent-starter-kits at `8f130b7cdc30510c929e6f7ebb07184f763e6ce4`, agent 0.1.0).

The worked example of the codespar-agent-builder skill: a read-only agent that reads the month's bills and cannot pay. Built from the five files, the packs and one kit module.

`@codespar/agent-core` and `@codespar/agent-runtime` are not published on npm, so the copies this agent was built
against are vendored here and linked as npm workspaces; the agent's own
`package.json` pins resolve to them unchanged:

  - `packages/agent-core/` — @codespar/agent-core 0.1.0
  - `packages/agent-runtime/` — @codespar/agent-runtime 0.1.0

```
  cp agents/hello-agent/.env.example agents/hello-agent/.env   # then fill in your keys
  npm install
  npm start
```

The agent's guide is [`agents/hello-agent/README.md`](agents/hello-agent/README.md); its commands run at this root
(`npm run check`, `npm run eval`, `npm test`) or inside `agents/hello-agent/`. The manifest pins
`cli: "@codespar/cli@0.14.0"`, the CLI version whose `agent run`/`eval` this agent was written for.
