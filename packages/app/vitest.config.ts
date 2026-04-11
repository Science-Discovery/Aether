import solidPlugin from "vite-plugin-solid"
import { fileURLToPath } from "url"

export default {
  plugins: [solidPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    dedupe: ["solid-js"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.vitest.ts", "src/**/*.vitest.tsx"],
    setupFiles: ["./src/test/jest-dom.ts", "./src/test/setup.ts"],
  },
}
