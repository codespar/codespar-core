/**
 * Query obrigatória aparece no `--help`, com exemplo.
 *
 * 25/10/2026, exercício da cli 0.20.0 em Test: `codespar shop instruments`
 * respondeu 400 `invalid_query` porque `owner` é query obrigatória de
 * `GET /v1/shop/agent/instruments`. O documento servido declarava isso, a
 * referência HTTP mostrava, e o `--help` do comando derivado só oferecia o
 * `-q` genérico. A tabela de operações jogava fora `parameters`.
 *
 * ⚠️ CONTROLE POSITIVO: um comando sem query obrigatória NÃO ganha a linha,
 * e ganha o exemplo mesmo assim.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { derivedHelpText } from "../derived-help.js";

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

describe("o --help de um comando derivado", () => {
  it("lista a query obrigatória e dá um exemplo com ela", () => {
    const texto = ajuda("shop", "instruments");
    expect(texto).toContain("Required query parameters: owner (pass each as -q name=value)");
    expect(texto).toContain("Example:\n  codespar shop instruments -q owner=<owner>");
  });

  it("não inventa a linha para quem não tem query obrigatória, e dá o exemplo com os posicionais", () => {
    const texto = ajuda("shop", "get-purchases");
    expect(texto).not.toContain("Required query parameters");
    expect(texto).toContain("Example:\n  codespar shop get-purchases <id>");
  });

  it("mostra o corpo no exemplo quando a operação declara um", () => {
    const texto = ajuda("shop", "create-purchases");
    expect(texto).toContain("Example:\n  codespar shop create-purchases -i '{...}'");
  });

  it("monta o texto só com o que a linha da tabela diz", () => {
    expect(
      derivedHelpText("boletos", {
        name: "list",
        params: ["consumerId"],
        requiredQuery: ["from_date", "to_date"],
        acceptsBody: false,
      }),
    ).toBe(
      "\nRequired query parameters: from_date, to_date (pass each as -q name=value)\n\nExample:\n  codespar boletos list <consumerId> -q from_date=<from_date> -q to_date=<to_date>\n",
    );
  });
});
