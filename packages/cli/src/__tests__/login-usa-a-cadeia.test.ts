/**
 * `login` resolve a base URL pela mesma cadeia que todo mundo.
 *
 * ## O que aconteceu
 *
 * Todo comando resolve flag → env → arquivo → padrão, por `resolveAuth()`.
 * `login` pulava o arquivo: lia `process.env.CODESPAR_BASE_URL` direto e caía
 * no padrão de produção. Quem fez `codespar login --base-url <staging>`, e
 * teve esse valor GRAVADO pelo próprio login, validava a chave seguinte
 * contra produção sem ser avisado.
 *
 * ## Como se mede sem depender da internet
 *
 * Um servidor HTTP local responde `/v1/whoami`. Ele entra no arquivo de
 * config como `baseUrl`, e o login roda sem `--base-url`. Se a cadeia for
 * respeitada, a requisição bate aqui e a chave é gravada; se o arquivo for
 * ignorado, o login vai para `api.codespar.dev` e este servidor não vê nada.
 *
 * O ambiente do teste exporta `CODESPAR_BASE_URL` VAZIA de proposito: e o
 * que um `env:` de CI faz, e era o segundo jeito de o arquivo ser ignorado
 * (`??` nao cai para o arquivo numa string vazia).
 *
 * ⚠️ CONTROLE POSITIVO. "Não bateu no servidor" também aconteceria se o
 * binário nem subisse, então o caso de cima exige o pedido RECEBIDO e a
 * chave gravada, e o de baixo prova que a flag ainda vence o arquivo.
 */

import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BIN = join(AQUI, "../../dist/index.js");

let servidor: Server | undefined;

function sobeServidor(): Promise<{ url: string; pedidos: string[] }> {
  const pedidos: string[] = [];
  return new Promise((resolve) => {
    servidor = createServer((req, res) => {
      pedidos.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: { email: "quem@exemplo.dev" }, org: { name: "Exemplo" } }));
    });
    servidor.listen(0, "127.0.0.1", () => {
      const porta = (servidor!.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${porta}`, pedidos });
    });
  });
}

function casaCom(config: Record<string, string>) {
  const casa = mkdtempSync(join(tmpdir(), "codespar-cadeia-"));
  mkdirSync(join(casa, ".codespar"));
  writeFileSync(join(casa, ".codespar", "config.json"), JSON.stringify(config));
  return casa;
}

/**
 * Assincrono de proposito: o servidor de teste vive NESTE processo, e
 * `spawnSync` bloqueia o laco de eventos do pai — o filho abriria a conexao e
 * ninguem a atenderia. O primeiro desenho deste teste travou 30s por isso.
 */
function roda(casa: string, args: string[]): Promise<{ status: number | null; saida: string }> {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: casa, USERPROFILE: casa, CODESPAR_API_KEY: "", CODESPAR_BASE_URL: "" },
    });
    let saida = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (saida += d));
    const relogio = setTimeout(() => filho.kill("SIGKILL"), 25_000);
    filho.on("close", (status) => {
      clearTimeout(relogio);
      resolve({ status, saida });
    });
  });
}

afterEach(() => {
  servidor?.close();
  servidor = undefined;
});

describe("login e a cadeia de resolução", () => {
  it("usa a base URL que está no arquivo de config", async () => {
    const { url, pedidos } = await sobeServidor();
    const casa = casaCom({ baseUrl: url });

    const r = await roda(casa, ["login", "--api-key", "csk_test_daqui"]);

    expect(pedidos).toContain("GET /v1/whoami");
    expect(r.status).toBe(0);
    const gravado = JSON.parse(readFileSync(join(casa, ".codespar", "config.json"), "utf8"));
    expect(gravado.apiKey).toBe("csk_test_daqui");
  }, 40_000);

  it("e a flag continua vencendo o arquivo", async () => {
    const { url, pedidos } = await sobeServidor();
    const casa = casaCom({ baseUrl: "http://127.0.0.1:9" });

    const r = await roda(casa, ["login", "--api-key", "csk_test_daflag", "--base-url", url]);

    expect(pedidos).toContain("GET /v1/whoami");
    expect(r.status).toBe(0);
    expect(existsSync(join(casa, ".codespar", "config.json"))).toBe(true);
  }, 40_000);
});
