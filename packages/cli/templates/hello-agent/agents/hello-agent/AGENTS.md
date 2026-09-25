# hello-agent — rules for a coding agent working here

1. This agent READS. No `payment` or `charge` meta-tool, `maturity` empty;
   adding one means adding the matching maturity key or `npm run check`
   refuses the pair.
2. The runner is `@codespar/agent-runtime`. Do not copy a command or a channel
   into `src/`; `npm run check` refuses `src/main.ts` and `src/commands/`.
3. `src/kit.ts` is the only seam. Everything else is a file.
4. The prompt may not name a `codespar_*` tool `tools.json` does not list.
5. `AGENTS.md` and `CLAUDE.md` are the same file. Change one, copy it.
6. Never write "verificavel por terceiro" here: this agent pays nothing and
   mints no receipt, so it has nothing a third party could check. The Ed25519
   seal belongs to a payment receipt (`npm run verify` in bills-agent).
7. `.env.example` declares exactly `CODESPAR_API_KEY` and `ANTHROPIC_API_KEY`.
8. The gates are `npm run check` and `npm run eval --workspace=agents/hello-agent`.
