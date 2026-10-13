/**
 * `login` e `whoami` dizem quem a credencial é, e não inventam uma pessoa.
 *
 * ## O que aconteceu
 *
 * `/v1/whoami` responde `user: null` para uma API key: a chave é de uma org e
 * de um projeto, não de uma pessoa. Os dois comandos liam `me.user?.email` e
 * imprimiam "Logged in as unknown user" e "User  (unknown)" para toda chave,
 * que é o único jeito de usar a CLI. O que identifica a credencial
 * (organização, projeto e chave) estava no corpo e não aparecia no login.
 *
 * ## Como se mede
 *
 * Um servidor HTTP local responde `/v1/whoami` com o corpo de cada caso, e o
 * binário roda contra ele. Os dois casos são cobertos nos dois comandos: sem
 * pessoa, que é o de uma chave, e com pessoa, que a API ainda pode devolver.
 */

import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BIN = join(AQUI, "../../dist/index.js");

const SEM_PESSOA = {
  user: null,
  organization: { id: "org_1", name: "Exemplo Ltda" },
  project: { id: "prj_0123456789abcdef", name: "Loja" },
  key: { id: "key_abc123", environment: "test", scopes: ["sessions:read", "tools:execute"] },
};
const COM_PESSOA = { ...SEM_PESSOA, user: { email: "quem@exemplo.dev", name: "Quem" } };
// O schema declara `name` como `string | null`, e "" é uma string: sem nome
// para quem lê, mas não para um `??`.
const NOME_VAZIO = {
  ...SEM_PESSOA,
  organization: { id: "org_1", name: "" },
  project: { id: "prj_0123456789abcdef", name: "" },
};

let servidor: Server | undefined;

function sobeServidor(corpo: unknown): Promise<string> {
  return new Promise((resolve) => {
    servidor = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(corpo));
    });
    servidor.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(servidor!.address() as { port: number }).port}`);
    });
  });
}

// Assíncrono porque o servidor vive neste processo: `spawnSync` travaria o
// laço de eventos que atende o filho.
function roda(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const casa = mkdtempSync(join(tmpdir(), "codespar-quem-"));
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: casa,
        USERPROFILE: casa,
        CODESPAR_API_KEY: "",
        CODESPAR_BASE_URL: "",
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    filho.stdout.on("data", (d) => (stdout += d));
    filho.stderr.on("data", (d) => (stderr += d));
    const relogio = setTimeout(() => filho.kill("SIGKILL"), 25_000);
    filho.on("close", (status) => {
      clearTimeout(relogio);
      resolve({ status, stdout, stderr });
    });
  });
}

const login = (url: string, extra: string[] = []) =>
  roda([...extra, "login", "--api-key", "csk_test_daqui", "--base-url", url]);
const whoami = (url: string, extra: string[] = []) =>
  roda([...extra, "whoami", "--api-key", "csk_test_daqui", "--base-url", url]);

afterEach(() => {
  servidor?.close();
  servidor = undefined;
});

describe("login", () => {
  it("sem pessoa, nomeia a organização, o projeto e a chave", async () => {
    const r = await login(await sobeServidor(SEM_PESSOA));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("✓ Logged in to Exemplo Ltda\n");
    expect(r.stderr).toContain("ℹ Project: Loja\n");
    expect(r.stderr).toContain("ℹ Key: key_abc123 (test)\n");
    expect(r.stderr).not.toMatch(/unknown/i);
    expect(r.stderr).not.toContain("Logged in as");
  }, 40_000);

  it("com pessoa, nomeia a pessoa e mantém organização, projeto e chave", async () => {
    const r = await login(await sobeServidor(COM_PESSOA));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("✓ Logged in as quem@exemplo.dev\n");
    expect(r.stderr).toContain("ℹ Organization: Exemplo Ltda\n");
    expect(r.stderr).toContain("ℹ Project: Loja\n");
    expect(r.stderr).toContain("ℹ Key: key_abc123 (test)\n");
  }, 40_000);

  it("sem nome, cai nos ids; sem id de chave, diz só o ambiente", async () => {
    const r = await login(
      await sobeServidor({
        user: null,
        organization: { id: "org_1", name: null },
        project: { id: "prj_0123456789abcdef", name: null },
        key: { environment: "test", scopes: [] },
      }),
    );

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("✓ Logged in to org_1\n");
    expect(r.stderr).toContain("ℹ Project: prj_0123456789abcdef\n");
    expect(r.stderr).toContain("ℹ Key: (test key)\n");
  }, 40_000);

  it("com nome vazio, cai nos ids como se o nome faltasse", async () => {
    const r = await login(await sobeServidor(NOME_VAZIO));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("✓ Logged in to org_1\n");
    expect(r.stderr).toContain("ℹ Project: prj_0123456789abcdef\n");
    expect(r.stderr).toContain("ℹ Key: key_abc123 (test)\n");
  }, 40_000);

  it("com `--json`, o documento leva `user: null` como a API devolveu", async () => {
    const url = await sobeServidor(SEM_PESSOA);
    const r = await login(url, ["--json"]);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ...SEM_PESSOA, base_url: url });
  }, 40_000);
});

describe("whoami", () => {
  it("sem pessoa, a tabela não tem linha `User`", async () => {
    const r = await whoami(await sobeServidor(SEM_PESSOA));

    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      "Organization  Exemplo Ltda",
      "Project       Loja",
      "Key           key_abc123",
      "Key env       test",
      "Scopes        sessions:read, tools:execute",
    ]);
  }, 40_000);

  it("com pessoa, a primeira linha é `User`", async () => {
    const r = await whoami(await sobeServidor(COM_PESSOA));

    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      "User          quem@exemplo.dev",
      "Organization  Exemplo Ltda",
      "Project       Loja",
      "Key           key_abc123",
      "Key env       test",
      "Scopes        sessions:read, tools:execute",
    ]);
  }, 40_000);

  it("sem nome, cai nos ids; sem ambiente de chave, a linha `Key env` some", async () => {
    const r = await whoami(
      await sobeServidor({
        user: null,
        organization: { id: "org_1", name: null },
        project: { id: "prj_0123456789abcdef", name: null },
        key: { id: "key_abc123", scopes: [] },
      }),
    );

    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      "Organization  org_1",
      "Project       prj_0123456789abcdef",
      "Key           key_abc123",
      "Scopes        (all)",
    ]);
  }, 40_000);

  it("com nome vazio, cai nos ids como se o nome faltasse", async () => {
    const r = await whoami(await sobeServidor(NOME_VAZIO));

    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      "Organization  org_1",
      "Project       prj_0123456789abcdef",
      "Key           key_abc123",
      "Key env       test",
      "Scopes        sessions:read, tools:execute",
    ]);
  }, 40_000);

  it("com `--json`, devolve o corpo como veio", async () => {
    const r = await whoami(await sobeServidor(SEM_PESSOA), ["--json"]);

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(SEM_PESSOA);
  }, 40_000);
});

/**
 * Um runtime mais antigo pode responder um corpo sem `project` e sem `key`.
 * Os dois comandos imprimem o que veio e omitem o resto: nenhum lança, e
 * nenhum preenche a falta com "unknown" ou "(none)".
 */
describe("corpo mais magro que o schema", () => {
  const MAGRO = { user: null, organization: { id: "org_1", name: "Exemplo Ltda" } };

  it("login imprime só a organização", async () => {
    const r = await login(await sobeServidor(MAGRO));

    expect(r.status).toBe(0);
    expect(r.stderr).toBe("✓ Logged in to Exemplo Ltda\n");
  }, 40_000);

  it("whoami imprime só a organização", async () => {
    const r = await whoami(await sobeServidor(MAGRO));

    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Organization  Exemplo Ltda\n");
    expect(r.stderr).toBe("");
  }, 40_000);

  it("nenhum caminho imprime um substituto para o que falta", async () => {
    const corpos = [SEM_PESSOA, COM_PESSOA, MAGRO, { user: null }, { user: null, key: { scopes: [] } }];
    for (const corpo of corpos) {
      const url = await sobeServidor(corpo);
      for (const r of [await login(url), await whoami(url)]) {
        expect(r.status).toBe(0);
        expect(r.stdout + r.stderr).not.toMatch(/unknown|\(none\)/i);
      }
      servidor?.close();
    }
  }, 60_000);
});
