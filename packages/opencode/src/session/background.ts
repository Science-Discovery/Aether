import { Session } from "."
import { Agent } from "../agent/agent"
import { SessionPrompt } from "./prompt"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Config } from "../config/config"
import { Permission } from "@/permission"
import { Discipline } from "./discipline"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { Log } from "@/util/log"
import { ModelID, ProviderID } from "../provider/schema"
import { MessageV2 } from "./message-v2"
import z from "zod"

export interface BackgroundResult {
  taskID: string
  status: "completed" | "error" | "partial" | "timeout" | "cancelled"
  text: string
  error?: {
    type: "api_error" | "permission" | "overflow" | "timeout" | "unknown"
    message: string
    statusCode?: number
    retryable: boolean
  }
  toolsUsed: string[]
  executionTime: number
  stepsCompleted: number
}

export interface SpawnInput {
  session: Session.Info
  agent: Agent.Info
  prompt: string
  categoryModel?: Provider.Model
  catCfg?: { prompt_append?: string }
  discipline: Discipline
  parentSessionID: string
  parentAbort: AbortSignal
  callerPermission: Permission.Ruleset
  fallbackModel: { modelID: string; providerID: string }
}

type State = {
  completed: Map<string, BackgroundResult>
}

export namespace BackgroundTask {
  const log = Log.create({ service: "background-task" })

  const state = Instance.state(
    (): State => ({
      completed: new Map(),
    }),
    async (current) => {
      current.completed.clear()
    },
  )

  export const Event = {
    Completed: BusEvent.define(
      "session.background_task.completed",
      z.object({
        parentSessionID: z.string(),
        taskID: z.string(),
        status: z.string(),
      }),
    ),
  }

  export async function spawn(input: SpawnInput): Promise<string> {
    const { session, agent, prompt, categoryModel, catCfg, discipline, parentSessionID, parentAbort } = input
    const st = state()
    const timeoutMs = discipline.timeout_seconds * 1000

    const childAbort = new AbortController()

    parentAbort.addEventListener("abort", () => childAbort.abort(), { once: true })

    const runTask = async () => {
      const startTime = Date.now()

      const promptParts = await SessionPrompt.resolvePromptParts(prompt).catch(() => [] as any[])

      if (catCfg?.prompt_append) {
        promptParts.push({ type: "text" as const, text: catCfg.prompt_append })
      }
      if (discipline.return_format === "structured") {
        promptParts.push({
          type: "text" as const,
          text: "IMPORTANT: Your final output must be in structured format (JSON or well-defined Markdown sections).",
        })
      }

      const config = await Config.get()
      const disabledTools = Permission.disabled(
        ["todowrite", "task", ...(config.experimental?.primary_tools ?? [])],
        session.permission ?? [],
      )

      const model = categoryModel
        ? {
            modelID: categoryModel.id as string & ModelID,
            providerID: categoryModel.providerID as string & ProviderID,
          }
        : {
            modelID: input.fallbackModel.modelID as string & ModelID,
            providerID: input.fallbackModel.providerID as string & ProviderID,
          }

      let resultText = ""
      let stepsCompleted = 0
      let toolsUsed: string[] = []
      let status: BackgroundResult["status"] = "completed"
      let error: BackgroundResult["error"] | undefined

      try {
        const promptResult = await SessionPrompt.prompt({
          sessionID: session.id,
          model,
          agent: agent.name,
          tools: Object.fromEntries([...disabledTools].map((t) => [t, false])),
          parts: promptParts,
          maxSteps: discipline.max_steps ?? agent.steps,
        })

        log.info("prompt returned", {
          sessionID: session.id,
          role: promptResult.info.role,
          partCount: promptResult.parts.length,
          partTypes: promptResult.parts.map((p) => p.type).join(","),
          hasText: promptResult.parts.some((p) => p.type === "text"),
        })

        resultText = promptResult.parts.findLast((x) => x.type === "text")?.text ?? ""
        stepsCompleted = promptResult.parts.filter((p) => p.type === "step-start").length
        toolsUsed = promptResult.parts
          .filter((p) => p.type === "tool" && p.state?.status === "completed")
          .map((p) => (p as any).tool ?? "unknown")
      } catch (e: any) {
        const classified = classifyError(e)
        status = classified.status
        error = classified.error
      }

      log.info("task finished", {
        sessionID: session.id,
        status,
        textLength: resultText.length,
        stepsCompleted,
        toolsUsed: toolsUsed.length,
      })

      const bgResult: BackgroundResult = {
        taskID: session.id,
        status,
        text: resultText,
        error,
        toolsUsed,
        executionTime: Date.now() - startTime,
        stepsCompleted,
      }

      st.completed.set(session.id, bgResult)

      Bus.publish(Event.Completed, {
        parentSessionID,
        taskID: session.id,
        status,
      }).catch(() => {})
    }

    setTimeout(() => {
      if (!st.completed.has(session.id)) {
        childAbort.abort()
        SessionPrompt.cancel(session.id)
        const timeoutResult: BackgroundResult = {
          taskID: session.id,
          status: "timeout",
          text: "",
          error: {
            type: "timeout",
            message: `Task timed out after ${discipline.timeout_seconds}s`,
            retryable: true,
          },
          toolsUsed: [],
          executionTime: timeoutMs,
          stepsCompleted: 0,
        }
        st.completed.set(session.id, timeoutResult)
      }
    }, timeoutMs)

    runTask().catch((e) => {
      log.info("runTask failed", { sessionID: session.id, error: String(e) })
    })

    childAbort.signal.addEventListener(
      "abort",
      () => {
        if (!st.completed.has(session.id)) {
          SessionPrompt.cancel(session.id)
          const cancelled: BackgroundResult = {
            taskID: session.id,
            status: "cancelled",
            text: "",
            toolsUsed: [],
            executionTime: 0,
            stepsCompleted: 0,
          }
          st.completed.set(session.id, cancelled)
        }
      },
      { once: true },
    )

    return session.id
  }

  export async function output(taskID: string): Promise<BackgroundResult> {
    const st = state()
    const completed = st.completed.get(taskID)
    if (completed) return completed

    return await new Promise<BackgroundResult>((resolve) => {
      const check = setInterval(() => {
        const result = st.completed.get(taskID)
        if (result) {
          clearInterval(check)
          resolve(result)
        }
      }, 500)
      setTimeout(() => {
        clearInterval(check)
        resolve({
          taskID,
          status: "error",
          text: "",
          error: { type: "unknown", message: "Timeout waiting for task result", retryable: true },
          toolsUsed: [],
          executionTime: 0,
          stepsCompleted: 0,
        })
      }, 600000)
    })
  }

  export async function status(
    taskID: string,
  ): Promise<"running" | "completed" | "error" | "partial" | "timeout" | "cancelled"> {
    const st = state()
    const completed = st.completed.get(taskID)
    if (completed) return completed.status
    return "running"
  }
}

function classifyError(e: any): { status: BackgroundResult["status"]; error?: BackgroundResult["error"] } {
  if (!e) return { status: "error" }
  const msg = e instanceof Error ? e.message : String(e)

  if (msg.includes("429") || msg.includes("503") || msg.includes("529")) {
    return {
      status: "error",
      error: { type: "api_error", message: msg, statusCode: parseInt(msg.match(/\d{3}/)?.[0] ?? "0"), retryable: true },
    }
  }

  if (msg.includes("permission") || msg.includes("denied") || msg.includes("rejected")) {
    return {
      status: "error",
      error: { type: "permission", message: msg, retryable: false },
    }
  }

  if (msg.includes("context") || msg.includes("overflow")) {
    return {
      status: "partial",
      error: { type: "overflow", message: msg, retryable: false },
    }
  }

  return {
    status: "error",
    error: { type: "unknown", message: msg, retryable: false },
  }
}
