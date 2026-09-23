# @codespar/claude — CHANGELOG

## 0.4.7 — 2026-09-23

### Fixed

- O que este pacote produz volta a entrar no SDK da Anthropic sem cast.
  `ClaudeTool.input_schema` era `Record<string, unknown>` e o `Tool.InputSchema`
  deles exige `type: "object"`, entao `ClaudeTool[]` nao era atribuivel a
  `ToolUnion[]`: passar a saida de `getTools()` direto para
  `claude.messages.create({ tools })` reprovava no `tsc`, embora funcionasse em
  runtime. `toClaudeTool` agora GARANTE a forma em vez de afirma-la.
- `handleToolUse` aceita `input: unknown`, que e como o `ToolUseBlock` da
  Anthropic o declara, em vez de exigir `Record<string, unknown>`. Passar o
  bloco direto — o uso do exemplo no topo do index.ts — reprovava.

Os dois usos estao no exemplo do proprio pacote e na doc publica. O teste
`atribuivel-ao-sdk-da-anthropic` fixa a compatibilidade por ATRIBUICAO, contra
uma copia transcrita da declaracao da Anthropic.
