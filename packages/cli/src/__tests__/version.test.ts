import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { VERSION } from "../version.js";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
  version: string;
};

describe("VERSION", () => {
  it("is the version the manifest declares", () => {
    expect(VERSION).toBe(manifest.version);
  });

  it("is a semantic version, not a placeholder", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("is not written down anywhere in the module", () => {
    // The defect this replaces was a literal: `export const VERSION = "0.5.5"`,
    // kept in sync by hand across 0.6.0, 0.6.1, 0.6.2 and 0.7.0, and wrong in
    // all four (core#144). A literal reintroduced here fails this, whatever
    // number it holds — including the right one, which is the point: right
    // today is what the old literal also was.
    const source = readFileSync(resolve(packageDir, "src/version.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("resolves the manifest from the built module as well as the source", () => {
    // `../package.json` is read relative to the module file, so it resolves
    // only while `src/` and the build output are both one level below the
    // package root. An outDir moved to `dist/esm/` would leave the source
    // reading the manifest and the published tarball throwing MODULE_NOT_FOUND
    // on first run — a failure no test that imports the source can see.
    const tsconfig = JSON.parse(
      readFileSync(resolve(packageDir, "tsconfig.json"), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        "",
      ),
    ) as { compilerOptions: { outDir: string; rootDir: string } };

    for (const dir of [tsconfig.compilerOptions.outDir, tsconfig.compilerOptions.rootDir]) {
      const absolute = resolve(packageDir, dir);
      expect(resolve(dirname(absolute), "package.json")).toBe(resolve(packageDir, "package.json"));
    }
  });

  it("is what the User-Agent carries", () => {
    // api.ts composes `codespar-cli/${VERSION}`. Both channels the issue named
    // — the flag and the header — stay on one source only while this holds.
    const source = readFileSync(resolve(packageDir, "src/api.ts"), "utf8");
    expect(source).toContain("`codespar-cli/${VERSION}`");
  });

  it("ships the manifest it reads", () => {
    // npm always includes package.json in a tarball, so this cannot drift
    // today; it is here so that a future `files` rewrite that tries to trim
    // the manifest reads as a deliberate act with a red test attached.
    expect(existsSync(resolve(packageDir, "package.json"))).toBe(true);
  });
});
