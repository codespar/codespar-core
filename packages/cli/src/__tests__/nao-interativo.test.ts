/**
 * A CLI num lugar sem teclado: CI, Dockerfile, `sh -c` de um agente.
 *
 * ## O que aconteceu
 *
 * `codespar login --api-key <chave>` imprimia o prompt `API key: `, não
 * gravava nada e saía **0**. Duas coisas se somavam:
 *
 * 1. `--api-key` estava declarada na raiz E em `login`. Medido no commander
 *    13.1.0: com o mesmo nome nos dois níveis o valor vai SEMPRE para a raiz,
 *    nas duas ordens (`login --api-key K` e `--api-key K login`), e o
 *    `opts.apiKey` do subcomando chega `undefined`. A ação lia só o do
 *    subcomando, então caía no prompt como se ninguém tivesse passado chave.
 * 2. Com stdin em EOF a promessa do `readline` nunca resolve, o processo fica
 *    sem trabalho pendente e o Node sai 0.
 *
 * O resultado é o pior formato de falha: o passo de CI fica verde e todo
 * comando seguinte diz "Not logged in". `init` tinha o mesmo desenho, sem
 * checar TTY antes do menu.
 *
 * ## Em subprocesso, de propósito
 *
 * O defeito mora no roteamento de opção do commander e no fim da fila de
 * eventos do Node. Nenhum dos dois aparece chamando `loginCommand()` direto;
 * os dois aparecem rodando o binário, que é o que o usuário faz.
 *
 * ⚠️ CONTROLE POSITIVO. Um teste que só exige saída não-zero passa igual se o
 * binário nem subir. Por isso cada caso afirma também o TEXTO da recusa, e o
 * caminho honesto (chave mal formada) tem de chegar à validação da chave, o
 * que prova que o valor da flag ATRAVESSOU o roteamento.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BIN = join(AQUI, "../../dist/index.js");

/** Porta fechada: qualquer requisição morre em ECONNREFUSED, sem rede real. */
const HOST_MORTO = "http://127.0.0.1:9";

function roda(args: string[], cwd?: string) {
  const casa = mkdtempSync(join(tmpdir(), "codespar-casa-"));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? casa,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: casa,
      USERPROFILE: casa,
      CODESPAR_API_KEY: "",
      CODESPAR_BASE_URL: "",
      CODESPAR_PROJECT: "",
    },
  });
  return { ...r, casa, saida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("sem teclado", () => {
  it("`login --api-key` não pergunta nada e usa a chave que recebeu", () => {
    const r = roda(["login", "--api-key", "csk_test_naoexiste", "--base-url", HOST_MORTO]);

    expect(r.saida).not.toContain("API key:");
    expect(r.status).not.toBe(0);
    expect(existsSync(join(r.casa, ".codespar", "config.json"))).toBe(false);
  }, 40_000);

  it("a chave passada ATRAVESSA o roteamento do commander", () => {
    // O caminho honesto do controle: uma chave mal formada só pode ser
    // recusada por quem a leu. Se a flag continuasse perdida, a saída seria o
    // prompt, não esta mensagem.
    const r = roda(["login", "--api-key", "isto-nao-e-uma-chave", "--base-url", HOST_MORTO]);

    expect(r.saida).toContain("csk_");
    expect(r.status).toBe(1);
  }, 40_000);

  it("a mesma chave antes do subcomando também atravessa", () => {
    const r = roda(["--api-key", "isto-nao-e-uma-chave", "--base-url", HOST_MORTO, "login"]);

    expect(r.saida).toContain("csk_");
    expect(r.status).toBe(1);
  }, 40_000);

  it("`login` sem chave e sem TTY recusa em vez de fingir que deu certo", () => {
    const r = roda(["login", "--base-url", HOST_MORTO]);

    expect(r.status).toBe(1);
    expect(r.saida).toContain("--api-key");
    expect(existsSync(join(r.casa, ".codespar", "config.json"))).toBe(false);
  }, 40_000);

  it("`init` sem TTY recusa em vez de sair 0 sem criar nada", () => {
    const destino = mkdtempSync(join(tmpdir(), "codespar-init-"));
    const r = roda(["init", "agente-de-teste"], destino);

    expect(r.status).toBe(1);
    expect(r.saida).toContain("--yes");
    expect(readdirSync(destino)).toEqual([]);
  }, 40_000);
});
