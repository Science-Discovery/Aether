import z from "zod"
import { SessionTask } from "@/automation/session-task"
import { LegacyDB } from "@/storage/legacy-db"

export namespace LegacyRepair {
  export const Mode = z.enum(["auto", "controlled-only"])

  export const Input = z.object({
    mode: Mode.default("auto"),
    force: z.boolean().default(false),
    status: LegacyDB.Status,
    merge: z.object({
      errors: z.array(z.string()),
    }),
  })

  export const Output = z.object({
    started: z.boolean(),
    reason: z.string(),
    sessionID: SessionTask.Output.shape.sessionID.optional(),
  })

  export type Input = z.infer<typeof Input>
  export type Output = z.infer<typeof Output>

  export function decide(raw: Input) {
    const input = Input.parse(raw)
    if (input.force) return { run: true, reason: "forced" }
    if (input.mode === "controlled-only") return { run: false, reason: "mode=controlled-only" }
    if (input.merge.errors.length > 0) return { run: true, reason: "merge-errors" }
    return { run: false, reason: "no-merge-errors" }
  }

  function prompt(input: Input) {
    const files = input.status.files.map((file) => `- ${file.path}`).join("\n")
    const errs = input.merge.errors.map((err) => `- ${err}`).join("\n")
    return [
      "侦测到旧版本数据库处理存在异常，请执行诊断与修复。",
      "仅处理当前目录顶层（不含子目录）中的 .db 文件。",
      "请以保守方式检查 aether-prod.db 与历史数据库文件，只做最小必要修复。",
      "如果需要写入，请优先保证不覆盖现有用户数据，并保留原始数据库文件。",
      "若遇到约束错误，请先识别缺失字段或依赖表，再决定是否需要最小修复。",
      "不要移动或删除任何历史 db 文件。",
      "请输出最终报告：检查结果、修复动作、剩余风险。",
      "扫描到的库：",
      files || "- 无",
      "已知异常信息：",
      errs || "- 无",
    ].join("\n")
  }

  export async function start(raw: Input): Promise<Output> {
    const input = Input.parse(raw)
    const next = decide(input)
    if (!next.run) {
      return {
        started: false,
        reason: next.reason,
      }
    }
    const task = await SessionTask.start({
      directory: input.status.directory,
      title: "Legacy database repair",
      prompt: prompt(input),
    }).catch(() => undefined)
    if (!task) {
      return {
        started: false,
        reason: "session-start-failed",
      }
    }
    return {
      started: true,
      reason: next.reason,
      sessionID: task.sessionID,
    }
  }
}
