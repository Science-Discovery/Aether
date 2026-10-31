import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createLogger, optimizeDeps, resolveConfig } from "vite"
import previews from "../vite-preview.js"

const app = fileURLToPath(new URL("..", import.meta.url))
const electron = path.resolve(app, "../desktop-electron/src/renderer")

describe("lazy preview development dependencies", () => {
  test.each([app, electron])(
    "optimizes private CommonJS imports from %s without missing includes",
    async (root) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aether-preview-deps-"))
      const warnings: string[] = []
      const logger = createLogger("silent")
      logger.warn = (message) => {
        warnings.push(message)
      }
      try {
        const config = await resolveConfig(
          {
            configFile: false,
            root,
            cacheDir: dir,
            customLogger: logger,
            // Exercise the explicit lazy imports without scanning unrelated app routes.
            optimizeDeps: { ...previews, entries: [], noDiscovery: true },
          },
          "serve",
        )
        const metadata = await optimizeDeps(config, true)
        const entries = Object.values(metadata.optimized)
        expect(
          warnings.filter((message) => /Failed to resolve dependency|Cannot optimize dependency/.test(message)),
        ).toEqual([])
        for (const name of ["exceljs", "ssf", "jszip"]) {
          const found = entries.filter((entry) => entry.src.replaceAll("\\", "/").includes(`/node_modules/${name}/`))
          expect(found.length, `${name} was not prebundled from ${root}`).toBeGreaterThan(0)
          for (const entry of found) expect((await fs.stat(entry.file)).size).toBeGreaterThan(0)
        }
      } finally {
        // mkdtemp owns this one cache directory, never a package's real dev cache.
        const relative = path.relative(os.tmpdir(), dir)
        if (relative.startsWith("aether-preview-deps-") && !relative.includes(path.sep)) {
          await fs.rm(dir, { recursive: true, force: true })
        }
      }
    },
    30000,
  )
})
