import path from "path"

type Cmd = {
  name: string
  args: string[]
  env?: Record<string, string>
}

function arg(name: string) {
  const key = `--${name}`
  const idx = process.argv.indexOf(key)
  if (idx < 0) return
  return process.argv[idx + 1]
}

async function run(cmd: Cmd) {
  console.log(`[watcher-test] run ${cmd.name}`)
  const proc = Bun.spawn(cmd.args, {
    cwd: root,
    env: { ...process.env, ...cmd.env },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  console.log(`[watcher-test] exit ${cmd.name} code=${code}`)
  if (code !== 0) throw new Error(`${cmd.name} failed with code ${code}`)
}

const root = path.resolve(import.meta.dir, "../../..")
const target = arg("root")
const source = arg("source")
const dirs = arg("dirs") ?? ""
const tries = arg("tries") ?? "3"
const rounds = arg("rounds") ?? "10"
const runParcel = arg("parcel") === "true"

if (!target || !source) {
  throw new Error("missing required args: --root <dir> --source <dir>")
}

const base = [
  process.execPath,
  "run",
  "--cwd",
  "packages/opencode",
  "script/repro-serve-crash.ts",
  "--compare",
  "true",
  "--tries",
  tries,
  "--profile",
  "all-off",
  "--mode",
  "defaults",
  "--root",
  target,
  "--source",
  source,
  "--rounds",
  rounds,
  "--delay",
  "80",
  "--warmup",
  "3000",
  "--wait",
  "3000",
  "--loops",
  "3",
  "--reset",
  "true",
  "--skip-dispose",
  "true",
]

if (dirs.length > 0) {
  base.push("--dirs", dirs)
}

await run({
  name: "app-unit-tests",
  args: [
    process.execPath,
    "test",
    "--cwd",
    "packages/app",
    "src/context/file/watcher.test.ts",
    "src/context/file/refresh-queue.test.ts",
  ],
})

await run({
  name: "app-ux-bench",
  args: [process.execPath, "run", "--cwd", "packages/app", "script/watcher-ux-bench.ts"],
})

await run({
  name: "fs-watch-stability",
  args: [...base],
})

if (runParcel) {
  await run({
    name: "parcel-control",
    args: [...base],
    env: { OPENCODE_EXPERIMENTAL_FILEWATCHER_FORCE_PARCEL: "true" },
  })
}

console.log("[watcher-test] done")
