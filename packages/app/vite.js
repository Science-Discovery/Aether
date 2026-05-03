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
    const file = join(dir, "aether", "serve-port")
    try {
      const port = readFileSync(file, "utf-8").trim()
      if (port) return port
    } catch {}
  }
  return undefined
}

function stripGitBashPrefix(path) {
  const idx = path.indexOf("/Git/")
  if (idx !== -1) return "/" + path.slice(idx + 5)
  const idx2 = path.indexOf("\\Git\\")
  if (idx2 !== -1) return "/" + path.slice(idx2 + 5)
  const idx3 = path.indexOf("/msys/")
  if (idx3 !== -1) return "/" + path.slice(idx3 + 6)
  const idx4 = path.indexOf("\\msys\\")
  if (idx4 !== -1) return "/" + path.slice(idx4 + 6)
  return null
}

function readBasePath() {
  const raw = process.env.VITE_BASE_PATH
  if (!raw) return "/"
  if (raw === "." || raw === "./") return "./"
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    const recovered = stripGitBashPrefix(raw)
    if (recovered) {
      console.warn(`[opencode] detected Git Bash path translation, corrected: "${raw}" → "${recovered}"`)
      return recovered
    }
    console.error(
      `[opencode] VITE_BASE_PATH "${raw}" is a Windows path, likely from Git Bash translation. Run from cmd.exe or set MSYS_NO_PATHCONV=1, or pass base path without leading slash: --basepath my/base/path`,
    )
    return "/"
  }
  return raw.startsWith("/") ? raw : `/${raw}`
}

function readRouterBase(base) {
  if (base === "./") return "/"
  return base
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
      const basePath = readBasePath()
      const routerBase = readRouterBase(basePath)
      const env = port ? { VITE_OPENCODE_SERVER_PORT: port } : {}
      if (port) console.log(`[opencode] auto-detected backend port: ${port}`)
      if (routerBase !== "/") console.log(`[opencode] base path: ${routerBase}`)
      env.VITE_BASE_PATH = routerBase
      return {
        base: basePath,
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
    enforce: "pre",
    transformIndexHtml(html) {
      return html.replace(
        /<script\s+id="oc-theme-preload-script"\s+src="[^"]*oc-theme-preload\.js"[^>]*><\/script>/,
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
