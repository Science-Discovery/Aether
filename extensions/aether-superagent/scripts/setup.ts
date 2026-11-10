import { createInterface } from "node:readline/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { writeFile } from "node:fs/promises"
import { canonical, outside } from "../src/workspace"
import { Aether } from "../src/aether"
import { baseURL } from "../src/control"

const { values } = parseArgs({ args: process.argv.slice(2), options: Object.fromEntries(
  ["repo", "state", "aether", "model", "workers", "port", "file"].map((key) => [key, { type: "string" as const }]),
) })
const terminal = process.stdin.isTTY && !values.repo ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
async function ask(key: string, label: string, fallback = "") {
  if (values[key]) return values[key]!
  return terminal ? (await terminal.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback : fallback
}
try {
  const selected = await ask("repo", "默认项目绝对路径（可留空，派工时选择）")
  const repo = selected ? canonical(selected) : undefined
  const state = canonical(await ask("state", "独立状态目录", path.join(homedir(), "data/aether-superagent", "default")))
  if (repo) outside(repo, state)
  const aether = baseURL(await ask("aether", "Aether API 地址", "http://127.0.0.1:19527"))
  const model = await ask("model", "模型 provider/model（留空使用 Aether 默认）")
  if (model && (!model.includes("/") || model.startsWith("/") || model.endsWith("/"))) throw new Error("Model must be provider/model.")
  const workers = Number(await ask("workers", "并发 worker", "2"))
  const port = Number(await ask("port", "协调器端口", "19700"))
  if (!Number.isInteger(workers) || workers < 1 || workers > 16 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("workers must be 1–16 and port must be 1–65535.")
  const file = path.resolve(values.file ?? "config.local.json")
  const config = { repo, state, aether, workers, port, ...(model ? { model: {
    providerID: model.slice(0, model.indexOf("/")), modelID: model.slice(model.indexOf("/") + 1),
  } } : {}) }
  // Never overwrite an existing user's configuration or write model credentials.
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.log(`Configuration: ${file}\nStart: bun start ${JSON.stringify(file)}\nCoordinator: http://127.0.0.1:${port}`)
  try {
    const health = await new Aether(aether, process.env.AETHER_AUTHORIZATION, 5000).request<{ healthy: boolean; version?: string }>(state, "/global/health")
    console.log(health.healthy ? `Aether connected${health.version ? ` (${health.version})` : ""}.` : "Aether is not ready yet.")
  } catch { console.log("Configuration saved. Start Aether or check AETHER_AUTHORIZATION before submitting tasks.") }
} finally { terminal?.close() }
