import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { Permission } from "@/permission"
import { Provider } from "../provider/provider"
import { Discipline, fromOverride } from "../session/discipline"

interface TaskMetadata {
  sessionId: string
  mode: string
  model: { modelID: string; providerID: string }
}

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  category: z
    .string()
    .describe(
      "Optional semantic category for model routing (e.g., 'quick', 'deep', 'ultrabrain'). Overrides the subagent's model while preserving its identity and permissions.",
    )
    .optional(),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  mode: z
    .enum(["serial", "concurrent", "background"])
    .describe(
      "Execution mode. serial: block until result (default). concurrent: run alongside other concurrent tasks, await all together. background: spawn and continue immediately, retrieve result later via background_output.",
    )
    .default("serial")
    .optional(),
  delegation_depth: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe("How many more delegation layers this sub-agent may spawn. 0 = no delegation (default).")
    .default(0)
    .optional(),
  permission_override: z
    .record(z.string(), z.string().array())
    .describe(
      "Dynamic permission overrides for this task. Keys are permission names, values are action + optional path patterns. Example: { edit: ['allow'], bash: ['deny'], task: ['deny'] }. Overrides are capped by parent permissions — sub-agent cannot gain permissions the parent lacks.",
    )
    .optional(),
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe("Maximum loop iterations for this sub-agent. Overrides agent's default steps.")
    .optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(600)
    .describe("Maximum execution time in seconds. On timeout, partial results are saved.")
    .default(300)
    .optional(),
  file_scope: z
    .string()
    .array()
    .describe("Glob patterns restricting file operations. Example: ['src/auth/**', 'test/**']")
    .optional(),
  return_format: z
    .enum(["text", "structured", "raw"])
    .describe("Output format discipline. text=default, structured=JSON/Markdown, raw=full trace.")
    .default("text")
    .optional(),
})

async function resolveCategoryModel(category: string): Promise<Provider.Model | undefined> {
  const cfg = await Config.get()
  const catCfg = cfg.category?.[category]
  if (!catCfg) return undefined
  const modelStr = catCfg.model
  if (!modelStr) return undefined
  const parsed = Provider.parseModel(modelStr)
  return Provider.getModel(parsed.providerID, parsed.modelID).catch(() => undefined)
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
  const cfg = await Config.get()
  const categories = cfg.category ?? {}

  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const categoryList = Object.entries(categories)
    .map(([name, c]) => `- ${name}: ${c.description ?? `Routes to ${c.model ?? "default model"}`}`)
    .join("\n")

  let description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  if (categoryList) {
    description += `\n\nAvailable categories for model routing (optional, overrides subagent model):\n${categoryList}`
  }
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const discipline: Discipline = {
        mode: params.mode ?? "serial",
        delegation_depth: params.delegation_depth ?? 0,
        permission_override: params.permission_override,
        max_steps: params.max_steps,
        timeout_seconds: params.timeout_seconds ?? 300,
        file_scope: params.file_scope,
        return_format: params.return_format ?? "text",
      }

      const depth = discipline.delegation_depth
      const overrideRuleset = discipline.permission_override ? fromOverride(discipline.permission_override) : undefined
      const callerPermission = caller?.permission ?? []
      const effectivePermission = Permission.intersection(callerPermission, agent.permission, overrideRuleset)
      if (depth === 0) {
        effectivePermission.push({ permission: "task", pattern: "*", action: "deny" })
      }

      const categoryModel = params.category ? await resolveCategoryModel(params.category) : undefined
      const catCfg = params.category ? cfg.category?.[params.category] : undefined

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: effectivePermission,
          delegationDepth: depth,
          maxSteps: discipline.max_steps ?? agent.steps,
          fileScope: discipline.file_scope,
        })
      })

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const fallbackModel = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      if (discipline.mode === "background") {
        const { BackgroundTask } = await import("../session/background")
        const taskID = await BackgroundTask.spawn({
          session,
          agent,
          prompt: params.prompt,
          categoryModel,
          catCfg,
          discipline,
          parentSessionID: ctx.sessionID,
          parentAbort: ctx.abort,
          callerPermission,
          fallbackModel,
        })
        const bgMetadata: TaskMetadata = {
          sessionId: session.id as string,
          mode: discipline.mode,
          model: {
            modelID: (categoryModel?.id ?? fallbackModel.modelID ?? "") as string,
            providerID: (categoryModel?.providerID ?? fallbackModel.providerID ?? "") as string,
          },
        }
        ctx.metadata({ title: params.description, metadata: bgMetadata })
        return {
          title: params.description,
          metadata: bgMetadata,
          output: [
            `Background task started. task_id: ${taskID}`,
            "Use the background_output tool to retrieve results when ready.",
          ].join("\n"),
        }
      }

      const model = categoryModel ? { modelID: categoryModel.id, providerID: categoryModel.providerID } : fallbackModel

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id as string,
          mode: discipline.mode,
          model: { modelID: model.modelID as string, providerID: model.providerID as string },
        } as TaskMetadata,
      })

      const messageID = MessageID.ascending()

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)
      if (catCfg?.prompt_append) {
        promptParts.push({
          type: "text",
          text: catCfg.prompt_append,
        })
      }
      if (discipline.return_format === "structured") {
        promptParts.push({
          type: "text",
          text: "IMPORTANT: Your final output must be in structured format (JSON or well-defined Markdown sections). Provide your answer in a clear, parseable structure.",
        })
      }

      const disabledTools = Permission.disabled(
        ["todowrite", "task", ...(config.experimental?.primary_tools ?? [])],
        effectivePermission,
      )

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: Object.fromEntries([...disabledTools].map((t) => [t, false])),
        parts: promptParts,
        maxSteps: discipline.max_steps ?? agent.steps,
      })

      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: session.id as string,
          mode: discipline.mode,
          model: { modelID: model.modelID as string, providerID: model.providerID as string },
        } as TaskMetadata,
        output,
      }
    },
  }
})
