import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { schema } from "./schema.js"

const root = path.resolve(import.meta.dir, "../..")
const cfg = await Bun.file(path.join(import.meta.dir, "workflow.json")).json()
const roles = [
  "contract",
  "fidelity",
  "solve",
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
for (const name of ["loca", "loca-status", "loca-accept", "loca-cancel"]) {
  const text = await readFile(path.join(root, "command", `${name}.md`), "utf8")
  if (Bun.YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)[1]).agent !== "loca")
    throw new Error(`Invalid command ${name}`)
}
const files = (await readdir(import.meta.dir)).filter((file) => file.endsWith(".js"))
for (const file of files)
  new Bun.Transpiler({ loader: "js" }).transformSync(await readFile(path.join(import.meta.dir, file), "utf8"))
if (cfg.reviewers < 2 || cfg.phases.at(-1) !== "awaiting_human") throw new Error("Invalid workflow policy")
console.log(`Validated ${roles.length} role definitions, 4 commands, JSON schemas and ${files.length} runtime modules.`)
