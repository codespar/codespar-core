/**
 * Single source of truth for the CLI version. Imported by index.ts (the
 * --version flag + banner) and api.ts (the User-Agent header) so the two
 * can never drift. Keep in sync with package.json on release (prepublishOnly
 * could assert equality if drift ever recurs).
 */
export const VERSION = "0.4.0";
