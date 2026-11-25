import { defineConfig } from "vitest/config";

export default defineConfig({
  // `server-only` resolves to an empty module under the react-server condition, as it does inside Next's server build.
  resolve: { conditions: ["react-server"] },
  ssr: { resolve: { conditions: ["react-server"] } },
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
});
