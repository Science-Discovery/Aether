import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import { join } from "path"
import { homedir } from "os"

function readServePort() {
  if (process.env.VITE_OPENCODE_SERVER_PORT) return process.env.VITE_OPENCODE_SERVER_PORT
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const portfile = join(xdg, "opencode", "serve-port")
  try {
    return readFileSync(portfile, "utf-8").trim()
  } catch {
    return undefined
  }
}

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      const port = readServePort()
      const env = port ? { VITE_OPENCODE_SERVER_PORT: port } : {}
      if (port) console.log(`[opencode] auto-detected backend port: ${port}`)
      return {
        define: Object.fromEntries(Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])),
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
          dedupe: ["solid-js"],
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
