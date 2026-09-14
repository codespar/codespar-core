/**
 * O programa SOBE. É o teste mais bobo desta suíte e o único que teria pego o
 * defeito que eu publiquei.
 *
 * ## O que aconteceu
 *
 * A 0.11.0 foi para o npm com um grupo derivado chamado `tools`, e
 * `program.command("tools")` já existia escrito à mão. O commander não avisa:
 * ele LANÇA, no momento do registro, antes de qualquer parse. `codespar --help`
 * abortava com um stack trace.
 *
 *     Error: cannot add command 'tools' as already have command 'tools'
 *
 * 113 testes passaram. Todos exercitavam `derivedSurface()`, a derivação, o
 * despacho de cada comando — e nenhum construía o programa inteiro. A suíte
 * media as peças e nunca a montagem.
 *
 * ## Por que em subprocesso, e não importando o módulo
 *
 * `index.ts` chama `program.parse()` no topo: importá-lo daqui executaria a
 * CLI dentro do vitest. O subprocesso é também o que o usuário faz, que é o
 * ponto — a lição que custou esta publicação é que CLI publicada se verifica
 * EXECUTANDO, não descompactando.
 *
 * ⚠️ CONTROLE POSITIVO. Um teste que roda `--help` e espera exit 0 passa
 * igual se o binário não existir e o spawn falhar de outro jeito. Então a
 * saída tem de conter a lista de comandos, e um nome inventado tem de fazer o
 * programa sair não-zero.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BIN = join(AQUI, "../../dist/index.js");

function roda(...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 30_000 });
}

describe("o programa sobe", () => {
  it("precisa do build: dist/index.js existe", () => {
    expect(
      existsSync(BIN),
      "dist/index.js não existe — rode `npm run build` no pacote antes deste teste",
    ).toBe(true);
  });

  it("`--help` sai 0 e lista os comandos, sem colisão de nome", () => {
    const r = roda("--help");
    const saida = `${r.stdout}${r.stderr}`;
    // A mensagem exata do defeito que motivou este teste.
    expect(saida, "colisão de nome de comando").not.toContain("already have command");
    expect(r.status, `\`codespar --help\` saiu ${r.status}:\n${saida}`).toBe(0);
    // CONTROLE: a saída é mesmo o help, e não vazio.
    expect(saida).toContain("Usage:");
    expect(saida.length).toBeGreaterThan(200);
  });

  // ⚠️ ORÇAMENTO EXPLÍCITO, e ele não é decoração. Este caso bota um processo
  // node de pé por grupo — onze hoje. Coube nos 5 s padrão do vitest na minha
  // máquina e ESTOUROU no runner, derrubando o publish da 0.11.1 depois do
  // merge: o pacote consertado não chegou ao npm e o quebrado continuou lá.
  // Um teste que mede boot é lento por construção; o número tem de ser dito.
  it(
    "todo grupo de recurso derivado responde a `--help`",
    async () => {
      const { derivedSurface } = await import("../surface.js");
      const grupos = derivedSurface().map((g) => g.spec.name);
      expect(grupos.length, "nenhum grupo derivado").toBeGreaterThan(5);
      // Em paralelo: são processos independentes, e em série o tempo é a soma.
      const saidas = await Promise.all(
        grupos.map(async (nome) => ({ nome, r: roda(nome, "--help") })),
      );
      const quebrados = saidas
        .filter(({ r }) => r.status !== 0)
        .map(({ nome, r }) => `${nome}: exit ${r.status} — ${`${r.stdout}${r.stderr}`.slice(0, 160)}`);
      expect(quebrados).toEqual([]);
    },
    60_000,
  );

  it("CONTROLE: um comando que não existe sai não-zero", () => {
    const r = roda("comando-que-nao-existe-mesmo");
    expect(r.status, "o programa aceitou um comando inventado").not.toBe(0);
  });
});
