import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const updater = process.env.OPENCODE_UPDATER_CHANNEL ?? "latest"

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.OPENCODE_UPDATER_CHANNEL": JSON.stringify(updater),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
      },
    },
  },
  renderer: {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
