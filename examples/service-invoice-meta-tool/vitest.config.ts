import { defineConfig } from "vitest/config";

// `live.test.ts` is a no-op when `CODESPAR_LIVE_SMOKE` is unset (the
// describe block skips itself), so `npm test` / `npm run validate` are
// safe to run without an Anthropic key. Invoke the live smoke
// explicitly via `npm run validate:live` (which sets the env var).
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 60000,
  },
});
