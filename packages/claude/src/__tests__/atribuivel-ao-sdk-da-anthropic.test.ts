/**
 * O que este pacote produz entra no SDK da Anthropic sem cast?
 *
 * POR QUE UM TESTE E NAO UMA LEITURA. Este pacote nao depende de
 * `@anthropic-ai/sdk` de proposito: ele so molda tools, e puxar o SDK inteiro
 * para isso seria caro. A consequencia e que nada impedia os dois formatos de
 * divergirem, e eles divergiram: ate 22/09/2026 `ClaudeTool.input_schema` era
 * `Record<string, unknown>`, e o `Tool.InputSchema` da Anthropic exige
 * `type: "object"`. Resultado: passar a saida de `getTools()` direto para
 * `claude.messages.create({ tools })` — que e o uso do exemplo no topo do
 * index.ts e o que a doc publica — reprovava no `tsc`. Em runtime funcionava,
 * entao ninguem via.
 *
 * O teste carrega uma COPIA da declaracao deles, transcrita de
 * `@anthropic-ai/sdk` v0.6x (`resources/messages/messages.d.ts`). Copia
 * envelhece, e por isso ela esta aqui em cima e nao escondida: quando a
 * Anthropic mudar a forma, este arquivo e o lugar de descobrir.
 */

import { describe, expect, it } from "vitest";
import { toClaudeTool, handleToolUse, type ClaudeTool } from "../index.js";
import { fakeSession } from "@codespar/sdk/testing";
import type { Tool } from "@codespar/sdk";

/** Transcrito de @anthropic-ai/sdk: Anthropic.Tool.InputSchema. */
interface InputSchemaDaAnthropic {
  type: "object";
  properties?: unknown | null;
  required?: Array<string> | null;
  [k: string]: unknown;
}
/** Transcrito de @anthropic-ai/sdk: Anthropic.Tool (os campos exigidos). */
interface ToolDaAnthropic {
  name: string;
  description?: string;
  input_schema: InputSchemaDaAnthropic;
}
/** Transcrito de @anthropic-ai/sdk: Anthropic.ToolUseBlock. */
interface ToolUseBlockDaAnthropic {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

const ferramenta: Tool = {
  name: "codespar_charge",
  description: "Cobra",
  input_schema: { properties: { amount: { type: "number" } }, required: ["amount"] },
  server: "asaas",
};

describe("atribuivel ao SDK da Anthropic", () => {
  it("um ClaudeTool entra onde a Anthropic pede um Tool", () => {
    const convertido = toClaudeTool(ferramenta);
    // A afirmacao e a ATRIBUICAO: se `ClaudeTool` deixar de ser compativel,
    // isto para de compilar, e o `tsc` do pacote reprova.
    const paraAAnthropic: ToolDaAnthropic = convertido;
    expect(paraAAnthropic.input_schema.type).toBe("object");
  });

  it("um array deles entra onde ela pede um array", () => {
    const lista: ToolDaAnthropic[] = [toClaudeTool(ferramenta)];
    expect(lista).toHaveLength(1);
  });

  it("garante `type: object` mesmo quando o schema do servidor não traz", () => {
    expect(toClaudeTool(ferramenta).input_schema.type).toBe("object");
    // e nao apaga o que o servidor mandou
    expect(toClaudeTool(ferramenta).input_schema.required).toEqual(["amount"]);
  });

  it("não sobrescreve um `type` que já veio correto", () => {
    const comTipo: Tool = { ...ferramenta, input_schema: { type: "object", properties: {} } };
    expect(toClaudeTool(comTipo).input_schema.type).toBe("object");
  });

  it("handleToolUse aceita um tool_use block da Anthropic sem cast", async () => {
    const bloco: ToolUseBlockDaAnthropic = {
      type: "tool_use", id: "toolu_1", name: "codespar_charge", input: { amount: 100 },
    };
    const session = fakeSession({
      codespar_charge: { success: true, data: { id: "pay_1" }, error: null, duration: 1, server: "asaas", tool: "codespar_charge" },
    });
    const r = await handleToolUse(session, bloco);
    expect(r.success).toBe(true);
  });

  it("CONTROLE: input ausente ou não-objeto vira {}, e não explode", async () => {
    const session = fakeSession({}, { lenient: true });
    for (const input of [undefined, null, "texto", 42]) {
      const r = await handleToolUse(session, { name: "codespar_charge", input });
      expect(r.success).toBe(true);
    }
  });

  it("CONTROLE: a cópia da declaração deles é exigente de verdade", () => {
    // Sem `type`, o objeto NAO passa como InputSchema. Se este teste parar de
    // valer, a copia acima virou frouxa e os outros casos nao afirmam nada.
    const semTipo = { properties: {} } as unknown as ClaudeTool["input_schema"];
    // @ts-expect-error `type` é obrigatório na declaração da Anthropic
    const _: InputSchemaDaAnthropic = { properties: {} };
    void _;
    expect(semTipo).toBeDefined();
  });
});
