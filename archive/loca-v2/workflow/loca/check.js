import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { schema } from "./schema.js"

const root = path.resolve(import.meta.dir, "../..")
const cfg = await Bun.file(path.join(import.meta.dir, "workflow.json")).json()
const roles = [
  "contract",
  "fidelity",
  "explore",
  "attack",
  "assemble",
  "split",
  "structure",
  "inputs",
  "validate",
  "reference",
  "reasoning",
  "computation",
  "questioner",
  "defender",
  "closing",
  "integrate",
]
for (const role of roles) {
  const text = await readFile(path.join(root, "agent", `loca-${role}.md`), "utf8")
  const front = Bun.YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)[1])
  if (front.mode !== "subagent" || front.hidden !== true || !text.includes("StructuredOutput"))
    throw new Error(`Invalid role ${role}`)
  z.toJSONSchema(schema(role))
}
const commands = ["loca", "loca-status", "loca-accept", "loca-cancel", "loca-assumptions"]
for (const name of commands) {
  const text = await readFile(path.join(root, "command", `${name}.md`), "utf8")
  if (Bun.YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)[1]).agent !== "loca")
    throw new Error(`Invalid command ${name}`)
}
const files = (await readdir(import.meta.dir)).filter((file) => file.endsWith(".js"))
for (const file of files)
  new Bun.Transpiler({ loader: "js" }).transformSync(await readFile(path.join(import.meta.dir, file), "utf8"))
if (cfg.reviewers < 2 || cfg.phases.at(-1) !== "awaiting_human") throw new Error("Invalid workflow policy")
for (const role of roles) {
  const limit = cfg.timeout?.[role]
  if (limit !== null && !(typeof limit === "number" && limit > 0))
    throw new Error(`Invalid timeout for role ${role}: expected positive milliseconds or null`)
}
if (cfg.execution?.timeout !== undefined) throw new Error("Execution must not define a hard timeout")
if (cfg.execution?.bytes < 1 || !cfg.execution?.python) throw new Error("Invalid execution policy")
if (cfg.idle !== undefined && !(typeof cfg.idle === "number" && cfg.idle > 0))
  throw new Error("Invalid idle watchdog policy")
console.log(
  `Validated ${roles.length} role definitions, ${commands.length} commands, JSON schemas and ${files.length} runtime modules.`,
)
