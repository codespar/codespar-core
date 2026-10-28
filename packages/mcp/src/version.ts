/**
 * The version this server announces in `initialize` (`serverInfo.version`) is the one npm published it
 * under: read from the package's own package.json at run time, never written twice. The 0.5.14 tarball
 * announced "0.5.13" because bin.ts carried the number as a literal that the release bump missed
 * (QA 28/10/2026). `../package.json` is the package root both from `src/` (tests) and from `dist/`
 * (installed), and npm always ships package.json in the tarball.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const MCP_VERSION: string = (require("../package.json") as { version: string }).version;
