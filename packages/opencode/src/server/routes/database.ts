import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { lazy } from "@/util/lazy"
import { LegacyDB } from "@/storage/legacy-db"
import { LegacyVerify } from "@/storage/legacy-verify"
import { SessionTask } from "@/automation/session-task"
import z from "zod"

const MergeInput = z.object({}).optional()

const MergeOutput = z.object({
  status: LegacyDB.Status,
  mode: z.enum(["noop", "copy", "agent"]),
  sessionID: SessionTask.Output.shape.sessionID.optional(),
  merge_state: LegacyDB.MergeState,
})

export const DatabaseRoutes = lazy(() =>
  new Hono()
    .get(
      "/legacy/status",
      describeRoute({
        summary: "Scan legacy databases",
        description: "Scan current data directory and report auto-merge status.",
        operationId: "database.legacy.status",
        responses: {
          200: {
            description: "Legacy database scan status",
            content: {
              "application/json": {
                schema: resolver(LegacyDB.Status),
              },
            },
          },
        },
      }),
      async (c) => c.json(await LegacyDB.status()),
    )
    .get(
      "/legacy/merge/state",
      describeRoute({
        summary: "Get merge state",
        description: "Get merge state after auto merge.",
        operationId: "database.legacy.merge.state",
        responses: {
          200: {
            description: "Merge state",
            content: {
              "application/json": {
                schema: resolver(LegacyDB.MergeState),
              },
            },
          },
        },
      }),
      async (c) => c.json(await LegacyDB.mergeState()),
    )
    .post(
      "/legacy/merge/state/reset",
      describeRoute({
        summary: "Reset merge state",
        description: "Mark merge completion state as consumed so restart will not re-show the completion toast.",
        operationId: "database.legacy.merge.state.reset",
        responses: {
          200: {
            description: "Reset merge state",
            content: {
              "application/json": {
                schema: resolver(LegacyDB.MergeState),
              },
            },
          },
        },
      }),
      async (c) => c.json(await LegacyDB.clearMergeState()),
    )
    .post(
      "/legacy/merge",
      describeRoute({
        summary: "Start legacy merge",
        description: "Automatically copy or agent-merge old opencode databases into the new target database.",
        operationId: "database.legacy.merge",
        responses: {
          200: {
            description: "Merge kickoff result",
            content: {
              "application/json": {
                schema: resolver(MergeOutput),
              },
            },
          },
        },
      }),
      async (c) => {
        MergeInput.parse(await c.req.json().catch(() => undefined))
        const status = await LegacyDB.status()
        const merge = await LegacyDB.mergeState()
        if (merge.state === "running" || merge.state === "done") {
          return c.json({
            status,
            mode: "noop",
            merge_state: merge,
          })
        }
        if (!status.should_merge) {
          return c.json({
            status,
            mode: "noop",
            merge_state: merge,
          })
        }

        await LegacyDB.ensureTarget()
        await LegacyDB.setBootState({
          should_merge: false,
          source_count: status.source_count,
          updated: Date.now(),
        })
        const files = status.files.filter((file) => file.name.startsWith("opencode")).map((file) => `- ${file.path}`).join("\n")
        const task = await SessionTask.begin({
          directory: status.directory,
          title: "Legacy database merge",
          prompt: [
            "请识别当前目录顶层（不含子目录）中的所有 opencode*.db 文件。",
            `请先将用户历史对话信息合并到临时文件 ${status.directory}/aether_temp.db。`,
            `只有在临时文件验收通过后，才允许再将 ${status.directory}/aether_temp.db 的结果整合进 ${status.target}。`,
            `不要删除、替换或移动当前正在使用的 ${status.target} 数据库文件；必须保留它，并以增量整合的方式写入。`,
            "请使用 latest_wins：time_updated/updated_at/updated/time_created/created_at/created 更晚者覆盖；时间相同按来源优先级与文件名稳定排序。",
            "project/workspace/session 必须按关系一致性合并，不能只按主键覆盖。",
            "规则1：project 的真实身份以 worktree 为先；只有 project.id 和 worktree 都一致时，才允许视为同一 project。",
            "规则2：如果不同源库中的 project.id 相同但 worktree 不同，必须为其中一方生成新的 project.id，并重写该源库中关联的 workspace.project_id、session.project_id、permission.project_id。",
            "规则3：workspace 的真实身份以 project/worktree + type + branch + directory 为先；如果 workspace.id 相同但这些信息不同，必须生成新的 workspace.id，并重写关联的 session.workspace_id。",
            "规则4：session.project_id 必须继续指向正确的 project；session.workspace_id 若存在，必须继续指向与该 session 同属项目的 workspace。",
            "合并完成后，请执行严格验收，不满足则不要宣布完成。",
            "验收要求1：先对 aether_temp.db 做验收，确认它可正常打开，关键表（至少 session、message、project、workspace，若源库存在）结构可查询。",
            "验收要求2：对每个源库统计关键表行数并与 aether_temp.db 比对，确认不存在明显丢失。",
            "验收要求3：抽样比对多个具体会话内容，确认源库中的历史对话在 aether_temp.db 中可找到。",
            "验收要求4：检查 session -> project -> workspace 关联关系是否正确，确认不会把会话挂到错误 worktree。",
            "验收要求5：对发生冲突的记录，核对结果是否符合 latest_wins。",
            "验收要求6：只有 aether_temp.db 验收通过后，才允许把它整合进 aether-prod.db。",
            "验收要求7：给出明确结论：通过 / 不通过；若不通过请说明问题并继续修复。",
            "不要移动或删除任何历史 db 文件。",
            "完成后输出合并与校验报告：成功库、失败库、冲突数、临时库验收结果、最终整合结果。",
            "文件列表：",
            files || "- 无",
          ].join("\n"),
        })

        const merge_state = await LegacyDB.setMergeState({
          state: "running",
          updated: Date.now(),
        })

        void task.done
          .then(async (result) => {
            if (result.aborted) {
              await LegacyDB.setMergeState({
                state: "error",
                updated: Date.now(),
                error: "merge-interrupted",
              })
              return
            }
            const report = await LegacyVerify.run()
            await LegacyDB.setMergeState({
              state: report.ok ? "done" : "error",
              updated: Date.now(),
              error: report.ok ? undefined : "consistency-check-failed",
              details: report.ok ? undefined : report.errors.slice(0, 20),
            })
          })
          .catch(async (error) => {
            await LegacyDB.setMergeState({
              state: "error",
              updated: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            })
          })

        return c.json({
          status,
          mode: "agent",
          sessionID: task.sessionID,
          merge_state,
        })
      },
    ),
)
