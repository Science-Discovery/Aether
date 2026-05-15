import path from "path"

function list(name: string) {
  return process.argv.flatMap((arg, index) => (arg === `--${name}` ? [process.argv[index + 1]] : []))
    .flatMap((value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean))
}

const env = { ...process.env }
const providers = list("provider")
const inputs = list("input")

if (providers.length > 0) env.OPENCODE_SYSTEM_TEST_PROVIDER = providers.join(",")
if (inputs.length > 0) env.OPENCODE_SYSTEM_TEST_INPUT = inputs.join(",")
if (process.argv.includes("--p1")) env.OPENCODE_SYSTEM_TEST_P1 = "1"

const proc = Bun.spawn(
  [
    "bun",
    "test",
    "--timeout",
    env.OPENCODE_SYSTEM_TEST_TIMEOUT ?? "180000",
    "test/system/llm-p0.test.ts",
  ],
  {
    cwd: path.join(import.meta.dir, "..", ".."),
    env,
    stdout: "inherit",
    stderr: "inherit",
  },
)

process.exit(await proc.exited)
