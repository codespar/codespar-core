import { defineConfig } from "vitest/config";

// `templates/` carries whole agent trees, tests included, that only run once
// scaffolded and installed. Vitest's default glob would collect them here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
