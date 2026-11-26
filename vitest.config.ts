import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // `server-only` resolves to an empty module under the react-server condition, as it does inside Next's server build.
        resolve: { conditions: ["react-server"] },
        ssr: { resolve: { conditions: ["react-server"] } },
        test: { name: "lib", include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
      },
      {
        // Page components render with React's client build, which the react-server condition leaves out; pages that
        // load data through `server-only` get its empty module, as they do inside Next's server build.
        resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "node_modules/server-only/empty.js") } },
        test: { name: "ui", include: ["src/**/*.test.tsx"] },
      },
    ],
  },
});
