/**
 * Uma ferramenta que responde `success: false` tem de derrubar o comando.
 *
 * ## O que aconteceu
 *
 * `codespar execute` escrevia "Tool call failed:" no stderr, imprimia o
 * resultado e RETORNAVA. Sem lançar, sem código de saída: o processo saía 0.
 * Quem escreve `codespar execute codespar_pay … && proxima-etapa` roda a
 * próxima etapa depois de um pagamento recusado.
 *
 * O caminho gêmeo, `codespar tool <nome>` (`meta-tool.ts`), sempre lançou
 * `CliError` no mesmo fio, então a mesma resposta do mesmo servidor saía 1
 * por um comando e 0 pelo outro.
 *
 * ⚠️ CONTROLE POSITIVO. Um comando que lançasse sempre passaria na metade de
 * cima, então a metade de baixo exige que `success: true` chegue ao fim sem
 * lançar. É o par que prova que o portão separa as duas respostas.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { executeCommand } from "../commands/execute.js";
import { CliError } from "../config.js";

const AUTH = { apiKey: "csk_test_notreal", baseUrl: "https://api.test.dev", server: "codespar" };

const SESSAO = {
  id: "sess_0000",
  org_id: "org_0000",
  user_id: "cli-user",
  servers: ["codespar"],
  status: "active",
  created_at: new Date().toISOString(),
  closed_at: null,
};

/** Responde a criação da sessão, ao execute e ao close, nada mais. */
function backend(resultado: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((input: unknown, init: unknown) => {
    const url = String(input);
    const metodo = (init as RequestInit | undefined)?.method ?? "GET";
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

    if (url.endsWith("/v1/sessions") && metodo === "POST") return json(SESSAO);
    if (url.endsWith(`/v1/sessions/${SESSAO.id}/execute`)) return json(resultado);
    if (url.endsWith(`/v1/sessions/${SESSAO.id}`) && metodo === "DELETE") return json({ ok: true });
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
}

const RECUSADA = {
  success: false,
  data: null,
  error: "charge declined by provider",
  duration: 12,
  server: "codespar",
  tool: "codespar_charge",
};

const ACEITA = { ...RECUSADA, success: true, data: { id: "chg_0000" }, error: null };

afterEach(() => vi.restoreAllMocks());

describe("uma ferramenta que recusa derruba o comando", () => {
  it("`execute` lança quando o resultado diz success: false", async () => {
    backend(RECUSADA);

    await expect(
      executeCommand("codespar_charge", { ...AUTH, input: "{}", json: true }),
    ).rejects.toThrow(CliError);
  });

  it("a mensagem carrega o erro que a ferramenta devolveu", async () => {
    backend(RECUSADA);

    await expect(
      executeCommand("codespar_charge", { ...AUTH, input: "{}" }),
    ).rejects.toThrow(/charge declined by provider/);
  });

  it("e um resultado bem-sucedido continua chegando ao fim", async () => {
    backend(ACEITA);

    await expect(
      executeCommand("codespar_charge", { ...AUTH, input: "{}", json: true }),
    ).resolves.toBeUndefined();
  });
});
