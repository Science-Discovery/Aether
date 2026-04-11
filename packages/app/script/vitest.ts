import fs from "fs"
import path from "path"

const modules = path.resolve(import.meta.dir, "../../../node_modules")

function findVitest(): string {
  // Standard node_modules path (Windows Bun installs here directly)
  const standard = path.join(modules, "vitest", "vitest.mjs")
  if (fs.existsSync(standard)) return standard

  // Bun cache directory (Linux/macOS uses .bun for hoisted packages)
  const bunDir = path.join(modules, ".bun")
  const dir = fs
    .readdirSync(bunDir)
    .filter((item) => item.startsWith("vitest@"))
    .toSorted()
    .at(-1)
  if (!dir) throw new Error(`missing vitest in ${bunDir}`)
  return path.join(bunDir, dir, "node_modules/vitest/vitest.mjs")
}

const bin = findVitest()
const proc = Bun.spawn(["node", bin, ...Bun.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
})

process.exit(await proc.exited)
