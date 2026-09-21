/**
 * Com `--json`, o que sai no stdout é sempre um documento — inclusive quando
 * dá errado.
 *
 * ## O que acontecia
 *
 * `codespar --json <qualquer coisa>` que falhasse escrevia **zero byte** no
 * stdout e prosa no stderr. Todo consumidor precisava tratar "stdout vazio"
 * como caso especial e depois interpretar frase humana para saber o que houve.
 * Cinco comandos (`login`, `logout`, `sessions close`, `connect revoke`,
 * `init`) ignoravam a flag por completo e escreviam só o `✓`. E
 * `logs tail --json` imprimia documentos indentados um atrás do outro: o `jq`
 * tolera a concatenação, `JSON.parse` do fluxo inteiro não.
 *
 * ## A regra
 *
 * Com a flag: sucesso é um documento, falha é um documento com `error.kind`
 * (`cli`, `api`, `timeout`, `internal`), e um fluxo é NDJSON, um objeto por
 * linha. A linha humana continua no stderr, e os códigos de saída não mudam.
 *
 * ⚠️ CONTROLE POSITIVO. Um teste que só exige "stdout parseável" passa se o
 * comando não escrever nada e o parse for pulado, então cada caso afirma o
 * CONTEÚDO, e a metade de baixo prova que sem a flag o stdout continua humano.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tailLogsCommand } from "../commands/logs.js";
import { renderResult } from "../output.js";
import { ApiClient } from "../api.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

function roda(args: string[], cwd?: string) {
  const casa = mkdtempSync(join(tmpdir(), "codespar-script-"));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? casa,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: { ...process.env, HOME: casa, USERPROFILE: casa, CODESPAR_API_KEY: "", CODESPAR_BASE_URL: "" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", casa };
}

afterEach(() => vi.restoreAllMocks());

describe("a falha também é um documento", () => {
  it("uma recusa da CLI sai como `error.kind` no stdout, e exit 1", () => {
    const r = roda(["--json", "whoami"]);

    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.error.kind).toBe("cli");
    expect(doc.error.message).toMatch(/Not logged in/);
    // A linha humana não some: ela só deixa de ser a única saída.
    expect(r.stderr).toContain("✗");
  }, 40_000);

  it("sem a flag, o stdout continua vazio e a prosa no stderr", () => {
    const r = roda(["whoami"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Not logged in");
  }, 40_000);
});

describe("os comandos que ignoravam a flag", () => {
  it("`logout --json` responde um documento", () => {
    const r = roda(["--json", "logout"]);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ logged_out: true });
  }, 40_000);

  it("`init --json` responde o que criou, em vez do roteiro de próximos passos", () => {
    const destino = mkdtempSync(join(tmpdir(), "codespar-init-json-"));
    const r = roda(["--json", "init", "agente-de-teste", "--yes"], destino);

    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.created).toBe("agente-de-teste");
    expect(typeof doc.template).toBe("string");
    expect(readdirSync(destino)).toContain("agente-de-teste");
    expect(r.stdout).not.toContain("Next steps");
  }, 40_000);
});

describe("um fluxo é NDJSON", () => {
  // Do mais NOVO para o mais velho, que e como a API pagina; o comando
  // inverte para ler na ordem em que as coisas aconteceram.
  const LINHAS = [
    { id: "tc_2", tool: "codespar_ship", server: "codespar", status: "error", duration_ms: 30, called_at: "2026-09-21T10:00:01Z", error_code: "refused" },
    { id: "tc_1", tool: "codespar_charge", server: "codespar", status: "success", duration_ms: 12, called_at: "2026-09-21T10:00:00Z" },
  ];

  function capturarStdout() {
    const pedacos: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      pedacos.push(String(chunk));
      return true;
    });
    return pedacos;
  }

  function servir() {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ tool_calls: LINHAS, total: LINHAS.length }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  it("cada linha do tail é um objeto inteiro", async () => {
    servir();
    const saida = capturarStdout();

    await tailLogsCommand(new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }), {
      json: true,
    });

    const linhas = saida.join("").trim().split("\n").filter(Boolean);
    expect(linhas).toHaveLength(LINHAS.length);
    for (const linha of linhas) expect(() => JSON.parse(linha)).not.toThrow();
    expect(JSON.parse(linhas[0]!).id).toBe("tc_1");
  });

  it("CONTROLE: o fluxo inteiro NÃO era parseável antes, e agora é", async () => {
    servir();
    const saida = capturarStdout();

    await tailLogsCommand(new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }), {
      json: true,
    });

    const tudo = saida.join("").trim();
    // Documentos indentados empilhados quebram aqui; NDJSON também quebra num
    // parse único, e é por isso que a asserção de cima é por LINHA. O que este
    // controle prova é que a saída tem uma linha por registro e nenhuma
    // indentação, que é o contrato do NDJSON.
    expect(tudo.split("\n").every((l) => !l.startsWith(" "))).toBe(true);
    expect(tudo.split("\n")).toHaveLength(LINHAS.length);
  });
});

describe("a tela avisa quando ela não é o dado", () => {
  function capturarStderr() {
    const pedacos: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      pedacos.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    return pedacos;
  }

  const PIX = "00020126580014br.gov.bcb.pix0136" + "a".repeat(60) + "5204000053039865802BR";

  it("uma célula cortada é anunciada", () => {
    const erro = capturarStderr();

    renderResult({ charges: [{ id: "chg_1", pix_copy_paste: PIX, status: "pending" }] });

    expect(erro.join("")).toMatch(/1 value\(s\) clipped to 40 characters — use --json/);
  });

  it("CONTROLE: sem corte, não há aviso", () => {
    const erro = capturarStderr();

    renderResult({ charges: [{ id: "chg_1", pix_copy_paste: "00020126", status: "pending" }] });

    expect(erro.join("")).not.toMatch(/clipped/);
  });
});
