import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { lazy } from "@/util/lazy"
import { LegacyDB } from "@/storage/legacy-db"
import z from "zod"
import { SessionTask } from "@/automation/session-task"

const MergeInput = z.object({}).optional()

const MergeOutput = z.object({
  status: LegacyDB.Status,
  sessionID: SessionTask.Output.shape.sessionID,
  archive_state: LegacyDB.ArchiveState,
})

const PreferenceInput = z.object({
  dismissed: z.boolean(),
})

export const DatabaseRoutes = lazy(() =>
  new Hono()
    .get(
      "/legacy/status",
      describeRoute({
        summary: "Scan legacy databases",
        description: "Scan current data directory and report legacy database statistics.",
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
      async (c) => {
        return c.json(await LegacyDB.status())
      },
    )
    .get(
      "/legacy/preference",
      describeRoute({
        summary: "Get legacy merge prompt preference",
        description: "Get whether legacy merge prompt is permanently dismissed.",
        operationId: "database.legacy.preference.get",
        responses: {
          200: {
            description: "Legacy prompt preference",
            content: {
              "application/json": {
                schema: resolver(LegacyDB.Preference),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await LegacyDB.preference())
      },
    )
    .patch(
      "/legacy/preference",
      describeRoute({
        summary: "Update legacy merge prompt preference",
        description: "Update whether legacy merge prompt is permanently dismissed.",
        operationId: "database.legacy.preference.patch",
        responses: {
          200: {
            description: "Updated legacy prompt preference",
            content: {
              "application/json": {
                schema: resolver(LegacyDB.Preference),
              },
            },
          },
        },
      }),
      async (c) => {
        const body = PreferenceInput.parse(await c.req.json())
        return c.json(await LegacyDB.setPreference(body))
      },
    )
    .get(
      "/legacy/archive/state",
      describeRoute({
        summary: "Get archive state",
        description: "Get asynchronous archive task state after agent-driven merge.",
        operationId: "database.legacy.archive.state",
        responses: {
          200: {
            description: "Archive state",
            content: {
              "application/json": {
                schema: resolver(LegacyDB.ArchiveState),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await LegacyDB.archiveState())
      },
    )
    .post(
      "/legacy/merge",
      describeRoute({
        summary: "Merge legacy databases",
        description: "Start agent-driven merge into aether-prod.db and run fixed archive after session completes.",
        operationId: "database.legacy.merge",
        responses: {
          200: {
            description: "Merge report",
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
        await LegacyDB.ensureTarget()
        const files = status.files.map((file) => `- ${file.path}`).join("\n")
        const task = await SessionTask.begin({
          directory: status.directory,
          title: "Legacy database merge",
          prompt: [
            "请识别当前目录顶层（不含子目录）中的所有 .db 文件。",
            "请将用户历史对话信息合并到 aether-prod.db。",
            "冲突策略：latest_wins（time_updated/updated_at/updated/time_created/created_at/created），时间相同按来源优先级与文件名稳定排序。",
            "不要移动或删除任何历史 db 文件。",
            "完成后请输出合并报告：成功库、失败库、冲突数。",
            "文件列表：",
            files || "- 无",
          ].join("\n"),
        })

        await LegacyDB.setArchiveState({
          state: "running",
          updated: Date.now(),
        })

        void task.done
          .then(async () => {
            const archive = await LegacyDB.archive()
            await LegacyDB.setArchiveState({
              state: "done",
              updated: Date.now(),
              result: archive,
            })
          })
          .catch(async (error) => {
            await LegacyDB.setArchiveState({
              state: "error",
              updated: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            })
          })

        return c.json({
          status,
          sessionID: task.sessionID,
          archive_state: await LegacyDB.archiveState(),
        })
      },
    ),
)
