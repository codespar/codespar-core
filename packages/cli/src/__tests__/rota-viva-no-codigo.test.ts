/**
 * Comando escrito à mão não chama rota que o documento enterrou.
 *
 * ## O que aconteceu
 *
 * Os comandos DERIVADOS ganharam a marca `deprecated` em 21/09 e passaram a
 * se anunciar. Os escritos à mão ficaram de fora dessa conta, porque a rota
 * deles é um literal no código, e um literal não aparece em tabela nenhuma.
 * Medido no documento servido: `POST /v1/connect/start`, que é o que
 * `codespar connect start` chamava, está depreciada, e a viva é
 * `POST /v1/connections/start` — mesmo `summary`, mesmo corpo, quatro campos
 * iguais.
 *
 * ## Por que estático
 *
 * A alternativa seria exercitar cada comando contra um servidor de mentira e
 * olhar a URL. Isto aqui responde a mesma pergunta lendo o que o código
 * escreve, e responde para os 33 comandos de uma vez, inclusive os que
 * ninguém está testando hoje.
 *
 * ⚠️ CONTROLE POSITIVO. Uma varredura que não casa chamada nenhuma passa
 * igual a uma que casa todas e não acha nada, então o teste de baixo planta
 * uma rota morta num texto e exige o relato, e confere que a varredura
 * enxergou um número plausível de chamadas.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONS } from "../surface.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `client.post("/v1/connect/start", …)` → `POST /v1/connect/start`. */
const CHAMADA = /\bclient\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g;

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return nome === "__tests__" ? [] : arquivos(caminho);
    return caminho.endsWith(".ts") ? [caminho] : [];
  });
}

function chamadas(texto: string): string[] {
  return [...texto.matchAll(CHAMADA)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
}

const MORTAS = new Set(
  OPERATIONS.filter((o) => o.deprecated).map((o) => `${o.method.toUpperCase()} ${o.path}`),
);

describe("o código chama a rota viva", () => {
  it("nenhuma chamada escrita à mão aponta para rota depreciada", () => {
    const achados: string[] = [];
    for (const arquivo of arquivos(SRC)) {
      const texto = readFileSync(arquivo, "utf8");
      for (const chamada of chamadas(texto)) {
        if (MORTAS.has(chamada)) achados.push(`${arquivo.slice(SRC.length + 1)}: ${chamada}`);
      }
    }
    expect(
      achados,
      "O documento servido marca esta rota como depreciada. NÃO feche isto " +
        "adicionando exceção: procure a rota viva no documento (quase sempre o mesmo " +
        "`summary` sob outro caminho, com o corpo idêntico) e troque a chamada. Se não " +
        "houver rota viva, a decisão é de produto e vira issue, não teste verde.",
    ).toEqual([]);
  });

  it("CONTROLE: a varredura enxerga chamadas, e acusa uma morta plantada", () => {
    const vistas = arquivos(SRC).flatMap((a) => chamadas(readFileSync(a, "utf8")));
    expect(vistas.length, "a varredura casa chamadas de verdade").toBeGreaterThan(5);
    expect(MORTAS.size, "o documento tem rotas depreciadas para comparar").toBeGreaterThan(10);

    const morta = [...MORTAS][0];
    const [verbo, caminho] = morta.split(" ");
    const plantado = `const x = await client.${verbo.toLowerCase()}("${caminho}", { body: {} });`;
    expect(chamadas(plantado)).toEqual([morta]);
  });
});
