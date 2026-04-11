import solidPlugin from "vite-plugin-solid"

export default {
  plugins: [solidPlugin()],
  test: {
    environment: "node",
    include: ["src/**/*.vitest.ts", "src/**/*.vitest.tsx"],
    setupFiles: ["./src/test/jest-dom.ts", "./src/test/setup.ts"],
  },
}
