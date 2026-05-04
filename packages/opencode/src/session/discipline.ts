import z from "zod"
import { Permission } from "@/permission"

export const Discipline = z.object({
  mode: z
    .enum(["serial", "concurrent", "background"])
    .describe(
      "serial: await result before proceeding. concurrent: start with other tasks, await all together. background: spawn immediately, main agent continues.",
    )
    .default("serial"),

  delegation_depth: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe("How many more delegation levels this sub-agent is allowed. 0 = cannot delegate at all.")
    .default(0),

  permission_override: z
    .record(z.string(), z.string().array())
    .describe(
      "Dynamic permission overrides. Keys are permission names, values are action + optional path patterns. Example: { edit: ['allow'], bash: ['deny'], glob: ['allow', 'src/auth/**'] }. Overrides are capped by parent permissions via intersection.",
    )
    .optional(),

  max_steps: z.number().int().min(1).max(50).describe("Maximum loop iterations for this sub-agent session.").optional(),

  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(600)
    .describe("Maximum execution time in seconds. On timeout, partial results are saved.")
    .default(300),

  file_scope: z
    .string()
    .array()
    .describe("Glob patterns restricting file-affecting tools. Example: ['src/auth/**', 'package.json']")
    .optional(),

  return_format: z
    .enum(["text", "structured", "raw"])
    .describe("text: final assistant text. structured: enforce JSON/Markdown output. raw: full conversation trace.")
    .default("text"),
})
export type Discipline = z.infer<typeof Discipline>

const VALID_ACTIONS = new Set(["allow", "deny", "ask"])

export function fromOverride(override: Record<string, string[]>): Permission.Ruleset {
  const ruleset: Permission.Ruleset = []
  for (const [permission, values] of Object.entries(override)) {
    const action = values[0]
    if (!VALID_ACTIONS.has(action)) continue
    if (values.length === 1) {
      ruleset.push({ permission, pattern: "*", action: action as Permission.Action })
    } else {
      for (let i = 1; i < values.length; i++) {
        ruleset.push({ permission, pattern: values[i], action: action as Permission.Action })
      }
    }
  }
  return ruleset
}
