import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import { join } from "path"
import { homedir } from "os"

function readServePort() {
  if (process.env.VITE_OPENCODE_SERVER_PORT) return process.env.VITE_OPENCODE_SERVER_PORT
  const dirs = [
    process.env.XDG_DATA_HOME,
    join(homedir(), ".local", "share"),
    join(homedir(), "Library", "Application Support"),
  ].filter((x) => typeof x === "string" && x.length > 0)
  for (const dir of dirs) {
    const file = join(dir, "opencode", "serve-port")
    try {
      const port = readFileSync(file, "utf-8").trim()
      if (port) return port
    } catch {}
  }
  return undefined
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

