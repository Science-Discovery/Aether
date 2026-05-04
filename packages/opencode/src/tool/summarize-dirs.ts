import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { FolderSummary } from "../file/summary"
import DESCRIPTION from "./summarize-dirs.txt"

export const SummarizeDirsTool = Tool.define("summarize_dirs", {
  description: DESCRIPTION,
  parameters: z.object({
    directory: z
      .string()
      .optional()
      .describe("Absolute path to the root directory to summarize. Defaults to the project root."),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Maximum directory depth to recurse into. Defaults to 3."),
    force: z.boolean().optional().describe("Regenerate summaries even if .summary already exists. Defaults to false."),
  }),
  async execute(params, ctx) {
    const root = params.directory ?? Instance.directory
    const maxDepth = params.maxDepth ?? 3
    const force = params.force ?? false

    const generated = await FolderSummary.generateAll(root, maxDepth, force, ctx.abort)

    const title = `Summarized ${generated.length} director${generated.length === 1 ? "y" : "ies"}`
    const output =
      generated.length > 0
        ? `${title}:\n${generated.join("\n")}`
        : "No new summaries generated. Use force=true to regenerate existing ones."

    return {
      title,
      output,
      metadata: { count: generated.length },
    }
  },
})
