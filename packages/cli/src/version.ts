import { createRequire } from "node:module";

/**
 * The CLI version, read from the package manifest.
 *
 * This was a hand-written literal, kept "in sync with package.json on
 * release". It drifted: 0.6.0, 0.6.1, 0.6.2 and 0.7.0 each bumped the
 * manifest and left the literal at 0.5.5, so the published 0.7.0 tarball
 * introduced itself as 0.5.5 in `--version`, in the banner and in every
 * User-Agent it sent (core#144). Three numbers for one release, and the
 * one the user read was the oldest.
 *
 * Reading the manifest removes the class rather than detecting it: npm
 * always publishes package.json, and it sits one directory above both
 * `src/` and `dist/`, so the same specifier resolves in the repo and in
 * the installed package. `createRequire` and not a JSON import because
 * `rootDir` is `./src` — an import would pull the manifest into the
 * compilation and tsc would refuse it as outside the root.
 */
const require = createRequire(import.meta.url);

export const VERSION: string = (require("../package.json") as { version: string }).version;
