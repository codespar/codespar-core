/**
 * Single source of truth for the CLI version. Imported by index.ts (the
 * --version flag + banner) and api.ts (the User-Agent header) so the two
 * can never drift.
 *
 * It is NOT read from package.json at runtime: `dist/index.js` is the published
 * bin, and reaching up out of `dist/` for a manifest is a resolution that breaks
 * differently under npx, a global install and a bundler. The literal stays, and
 * what keeps it honest is `src/__tests__/version.test.ts`, which fails the build
 * whenever this string and `package.json`'s `version` disagree — including on
 * the release commit that bumps the manifest and forgets this line, which is
 * exactly how it came to say 0.5.5 while 0.6.0 was on the registry.
 *
 * So: bump this WITH package.json, in the same commit. CI will not let the pair
 * separate again.
 */
export const VERSION = "0.6.0";
