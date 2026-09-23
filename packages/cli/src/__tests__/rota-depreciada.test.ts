/**
 * Rota que o documento enterrou não vira comando calado.
 *
 * ## O que aconteceu
 *
 * 22 dos 88 comandos derivados batiam em rota marcada `deprecated` no
 * documento servido, e nada dizia isso: nem o `--help`, nem a doc gerada a
 * partir dele. O grupo `triggers` era o caso inteiro: `/v1/triggers` está 12
 * de 12 depreciada, e quem está viva é `/v1/webhook-endpoints`, que não tinha
 * um comando sequer. A exceção de cobertura escrita à mão dizia o contrário
 * do documento ("the same ten operations as `triggers`, under the OLDER path
 * family"), e foi essa frase invertida que sustentou a escolha.
 *
 * A causa de raiz não era a escolha, era a cegueira: `API_OPERATIONS` trazia
 * `method`, `path`, `body` e `accept`, e jogava fora o `deprecated` do
 * documento. Quem gera comando a partir da tabela não tinha como saber.
 *
 * ## A regra
 *
 * Duas metades. A família sem nenhuma operação viva sai do censo, então
 * ninguém cobra comando para ela nem precisa escrever exceção. E o comando
 * que ainda assim nasce sobre rota morta — porque o prefixo do grupo é vivo e
 * uma rota debaixo dele não é — diz isso no próprio `--help`.
 *
 * ⚠️ CONTROLE POSITIVO. Marcar tudo como depreciado passaria na metade de
 * cima, então a metade de baixo exige que exista rota viva marcada como viva,
 * e que um comando vivo NÃO carregue o aviso.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { census, censusGroup, derivedSurface, OPERATIONS } from "../surface.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BIN = join(AQUI, "../../dist/index.js");

function ajuda(...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("a tabela de operações carrega a marca do documento", () => {
  it("marca as depreciadas e não marca as vivas", () => {
    const triggers = OPERATIONS.filter((o) => o.path.startsWith("/v1/triggers"));
    const webhooks = OPERATIONS.filter((o) => o.path.startsWith("/v1/webhook-endpoints"));

    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers.every((o) => o.deprecated)).toBe(true);
    expect(webhooks.length).toBeGreaterThan(0);
    expect(webhooks.every((o) => !o.deprecated)).toBe(true);
  });
});

describe("família morta não é cobrada, e comando morto se anuncia", () => {
  it("uma família 100% depreciada sai do censo", () => {
    const grupos = [...census().keys()];
    expect(grupos).not.toContain("triggers");
    expect(grupos).toContain("webhook-endpoints");
  });

  it("o grupo `triggers` aponta para a rota viva, com as mesmas grafias", () => {
    const grupo = derivedSurface().find((g) => g.spec.name === "triggers");
    expect(grupo).toBeDefined();
    expect(grupo!.commands.every((c) => c.path.startsWith("/v1/webhook-endpoints"))).toBe(true);
    // As grafias são contrato: estão no script de alguém.
    expect(grupo!.commands.map((c) => c.name).sort()).toEqual(
      [
        "create",
        "delete",
        "deliveries-redeliver",
        "dlq",
        "get",
        "get-deliveries",
        "list",
        "list-deliveries",
        "retry-pending",
        "rotate-secret",
        "test-fire",
        "update",
      ].sort(),
    );
  });

  it("todo comando derivado sobre rota morta diz `(deprecated)` no --help", () => {
    const mortos = derivedSurface().flatMap(({ spec, commands }) =>
      commands.filter((c) => c.deprecated).map((c) => ({ grupo: spec.name, nome: c.name })),
    );
    expect(mortos.length).toBeGreaterThan(0);

    const calados = mortos.filter(({ grupo, nome }) => {
      const linhas = ajuda(grupo).split("\n");
      const inicio = linhas.findIndex((l) => new RegExp(`^\\s+${nome}(?=\\s|$)`).test(l));
      if (inicio === -1) return true;
      // Sem TTY o commander quebra a descricao em 80 colunas, e num caminho
      // longo (`/v1/charges/{chargeId}/sandbox/pay`) a marca cai na linha
      // seguinte, que so carrega espaco antes do texto. O comando continua
      // se anunciando; e o teste que precisa ler a linha inteira.
      let linha = linhas[inicio];
      for (let j = inicio + 1; j < linhas.length && /^\s{3,}\S/.test(linhas[j]); j++) {
        linha += ` ${linhas[j].trim()}`;
      }
      return !linha.includes("(deprecated)");
    });

    expect(calados).toEqual([]);
  }, 60_000);

  it("e um comando vivo não carrega o aviso", () => {
    const linha = ajuda("wallets")
      .split("\n")
      .find((l) => /^\s+list\b/.test(l));

    expect(linha).toBeDefined();
    expect(linha).not.toContain("(deprecated)");
  }, 40_000);

  it("o censo e a cobertura falam da mesma coisa", () => {
    const cobertos = new Set(
      derivedSurface().flatMap(({ commands }) => commands.map((c) => censusGroup(c.path))),
    );
    expect(cobertos).toContain("webhook-endpoints");
  });
});
