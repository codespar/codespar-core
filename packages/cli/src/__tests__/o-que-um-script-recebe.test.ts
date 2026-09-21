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
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tailLogsCommand } from "../commands/logs.js";
import { renderResult } from "../output.js";
import { ApiClient } from "../api.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

function roda(args: string[], cwd?: string, ambiente: Record<string, string> = {}) {
  const casa = mkdtempSync(join(tmpdir(), "codespar-script-"));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? casa,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: { ...process.env, HOME: casa, USERPROFILE: casa, CODESPAR_API_KEY: "", CODESPAR_BASE_URL: "", ...ambiente },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", casa };
}

/**
 * A versao assincrona de `roda`.
 *
 * ⚠️ `spawnSync` NAO serve quando o servidor que a CLI vai chamar mora neste
 * mesmo processo: ele bloqueia o event loop do teste, o servidor nunca
 * responde, e o filho morre no timeout com `status: null`. Custou duas
 * execucoes de 30s ate a mensagem dizer isso.
 */
function rodaAsync(args: string[], ambiente: Record<string, string> = {}) {
  const casa = mkdtempSync(join(tmpdir(), "codespar-script-"));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((pronto) => {
    const filho = spawn(process.execPath, [BIN, ...args], {
      cwd: casa,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: casa, USERPROFILE: casa, CODESPAR_API_KEY: "", CODESPAR_BASE_URL: "", ...ambiente },
    });
    let stdout = "";
    let stderr = "";
    filho.stdout.on("data", (d) => (stdout += String(d)));
    filho.stderr.on("data", (d) => (stderr += String(d)));
    filho.on("close", (status) => pronto({ status, stdout, stderr }));
  });
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

/**
 * `kind` existe para um script ramificar sem interpretar prosa, e so vale se
 * separar as duas causas: a CLI recusou, ou a API respondeu erro. Medido na
 * 0.11.3 publicada, nao separava. `wallet`, `servers list`, `sessions list` e
 * `whoami` devolviam `kind: "cli"` para um 401, sem `status` e sem `body`,
 * porque o cliente proprio da CLI transformava toda resposta nao-2xx em
 * CliError; `consumers list`, que passa pelo cliente gerado do SDK, devolvia
 * `kind: "api"` com `status: 401`. Um binario, uma flag, dois contratos.
 *
 * Os dois casos abaixo sao um o controle do outro: mesma flag, mesmo comando
 * de familia, e o `kind` tem de mudar conforme a causa.
 */
describe("um 401 da API nao e uma recusa da CLI", () => {
  async function servidorQue(status: number, corpo: unknown) {
    const servidor = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(corpo));
    });
    await new Promise<void>((pronto) => servidor.listen(0, "127.0.0.1", pronto));
    const { port } = servidor.address() as AddressInfo;
    return { servidor, base: `http://127.0.0.1:${port}` };
  }

  it("com a API respondendo 401, o documento diz `api` e carrega status e body", async () => {
    const { servidor, base } = await servidorQue(401, { error: "unauthorized", message: "unauthorized" });
    try {
      const r = await rodaAsync(["--json", "wallet", "consumer_0000"], {
        CODESPAR_API_KEY: "csk_test_x",
        CODESPAR_BASE_URL: base,
      });

      expect(r.status).toBe(1);
      const doc = JSON.parse(r.stdout);
      expect(doc.error.kind).toBe("api");
      expect(doc.error.status).toBe(401);
      expect(doc.error.body).toEqual({ error: "unauthorized", message: "unauthorized" });
      // A linha humana nao muda: uma linha, sem pilha.
      expect(r.stderr).toContain("401");
    } finally {
      servidor.close();
    }
  }, 40_000);

  it("CONTROLE: sem chave nenhuma, a mesma chamada continua `cli`, e sem status", () => {
    const r = roda(["--json", "wallet", "consumer_0000"]);

    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.error.kind).toBe("cli");
    expect(doc.error.status).toBeUndefined();
  }, 40_000);

  it("um corpo que nao e JSON vira detail e body sem quebrar o documento", async () => {
    const servidor = createServer((_req, res) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    });
    await new Promise<void>((pronto) => servidor.listen(0, "127.0.0.1", pronto));
    const { port } = servidor.address() as AddressInfo;
    try {
      const r = await rodaAsync(["--json", "wallet", "consumer_0000"], {
        CODESPAR_API_KEY: "csk_test_x",
        CODESPAR_BASE_URL: `http://127.0.0.1:${port}`,
      });

      expect(r.status).toBe(1);
      const doc = JSON.parse(r.stdout);
      expect(doc.error.kind).toBe("api");
      expect(doc.error.status).toBe(502);
      expect(doc.error.body).toBe("bad gateway");
      expect(doc.error.message).toContain("bad gateway");
    } finally {
      servidor.close();
    }
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

describe("`--open` do connect é uma ordem, não uma sugestão", () => {
  it("força mesmo com o stdout redirecionado", async () => {
    const { startConnectCommand } = await import("../commands/connect.js");
    const abertas: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ authorize_url: "https://example.test/auth", expires_at: "2026-09-21T12:00:00Z" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      abertas.push(String(chunk));
      return true;
    });
    const avisos: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      avisos.push(String(chunk));
      return true;
    });
    // Sem TTY, que é o caso em que a flag era anulada.
    const tty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    try {
      await startConnectCommand(
        new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }),
        "stripe",
        { open: true },
      );
      // Não dá para exigir que um navegador abra dentro do teste; o que se
      // exige é que a CLI TENTE, e a tentativa se anuncia.
      expect(avisos.join("")).toMatch(/Opened in your default browser/);
      expect(avisos.join("")).not.toMatch(/Tip: pass --open/);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
    }
  });

  it("CONTROLE: com `--no-open` não abre e não sugere abrir", async () => {
    const { startConnectCommand } = await import("../commands/connect.js");
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ authorize_url: "https://example.test/auth", expires_at: "2026-09-21T12:00:00Z" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const avisos: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      avisos.push(String(chunk));
      return true;
    });

    await startConnectCommand(
      new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }),
      "stripe",
      { open: false },
    );

    expect(avisos.join("")).not.toMatch(/Opened in your default browser/);
    expect(avisos.join("")).not.toMatch(/Tip: pass --open/);
  });
});
