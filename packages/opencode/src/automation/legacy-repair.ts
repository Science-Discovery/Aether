import z from "zod"
import { SessionTask } from "@/automation/session-task"
import { LegacyDB } from "@/storage/legacy-db"

export namespace LegacyRepair {
  export const Mode = z.enum(["auto", "controlled-only"])

  export const Input = z.object({
    mode: Mode.default("auto"),
    force: z.boolean().default(false),
    status: LegacyDB.Status,
    merge: LegacyDB.Merge,
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
      "侦测到旧版本数据库合并存在失败项，请执行兜底修复。",
      "仅处理当前目录顶层（不含子目录）中的 .db 文件。",
      "目标是将用户历史信息汇总到 opencode-prod.db。",
      "优先策略：latest_wins（time_updated/updated_at/updated/time_created/created_at/created），时间相同时按来源优先级与文件名稳定排序。",
      "若遇到约束错误，请先识别缺失字段或依赖表并做最小修复后继续合并。",
      "不要移动或删除任何历史 db 文件。",
      "请输出最终报告：成功源库、失败源库、冲突数量、修复动作、剩余风险。",
      "扫描到的库：",
      files || "- 无",
      "受控合并器失败信息：",
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
    })
    return {
      started: true,
      reason: next.reason,
      sessionID: task.sessionID,
    }
  }
}
