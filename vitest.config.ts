import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**", "spikes/**"],
    environment: "node",
    clearMocks: true,
  },
});
