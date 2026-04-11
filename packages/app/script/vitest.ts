import fs from "fs"
import path from "path"

const root = path.resolve(import.meta.dir, "../../../node_modules/.bun")

const pick = (prefix: string, file: string) => {
  const dir = fs
    .readdirSync(root)
    .filter((item) => item.startsWith(prefix))
    .toSorted()
    .at(-1)
  if (!dir) throw new Error(`missing ${prefix} in ${root}`)
  return path.join(root, dir, file)
}

const bin = pick("vitest@", "node_modules/vitest/vitest.mjs")
const proc = Bun.spawn(["node", bin, ...Bun.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
})

process.exit(await proc.exited)
