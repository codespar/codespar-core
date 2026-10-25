/**
 * `codespar payables`: the files/batches routes have a hand-written subgroup
 * (upload needs a multipart body from a local path), and the derivation
 * must not publish a second spelling of each beside it.
 *
 * Found on 2026-10-25 when the snapshot refresh (0.16.20) brought the seven
 * routes into the operation table: the built binary listed
 * `files-authorizations`, `create-batches`, `get-batches`,
 * `update-batches-items`, `create-batches-items` and `batches-pay` next to
 * `files` and `batches`, because the reservation went by name and only
 * `files` collided. It now goes by route.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { derivedSurface, underPrefix } from "../surface.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BIN = join(AQUI, "../../dist/index.js");

function comandosDe(grupo: string): string[] {
  const r = spawnSync(process.execPath, [BIN, grupo, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const texto = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const depois = texto.split(/^Commands:\s*$/m)[1] ?? "";
  return depois
    .split("\n")
    .map((l) => l.match(/^ {2}(\S+)/)?.[1])
    .filter((n): n is string => Boolean(n) && n !== "help");
}

const RESERVADAS = ["/v1/payables/files", "/v1/payables/batches"];

describe("codespar payables and its hand-written subgroups", () => {
  it("the document does derive the files/batches routes (the exclusion is in the binary, not the table)", () => {
    const payables = derivedSurface().find((g) => g.spec.name === "payables");
    const reservadas = payables!.commands.filter((c) => RESERVADAS.some((p) => underPrefix(c.path, p)));
    expect(reservadas.map((c) => c.name).sort()).toEqual(
      [
        "batches-pay",
        "create-batches",
        "create-batches-items",
        "files",
        "files-authorizations",
        "get-batches",
        "update-batches-items",
      ].sort(),
    );
  });

  it("the binary publishes each reserved route once, under the hand-written subgroup", () => {
    const nomes = comandosDe("payables");
    expect(nomes).toContain("files");
    expect(nomes).toContain("batches");
    // Control: a derived command outside the reserved routes is still there.
    expect(nomes).toContain("documents");
    expect(nomes).toContain("get");
    const payables = derivedSurface().find((g) => g.spec.name === "payables")!;
    const segundaGrafia = payables.commands
      .filter((c) => RESERVADAS.some((p) => underPrefix(c.path, p)))
      .map((c) => c.name)
      .filter((n) => n !== "files" && n !== "batches");
    expect(segundaGrafia.length).toBeGreaterThan(0);
    expect(nomes.filter((n) => segundaGrafia.includes(n))).toEqual([]);
    expect(nomes.filter((n, i) => nomes.indexOf(n) !== i)).toEqual([]);
  });
});
