import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { LegacyDB } from "@/storage/legacy-db"
import { lazy } from "@/util/lazy"

const MergeInput = z.object({}).optional()

const MergeOutput = z.object({
  status: LegacyDB.Status,
  mode: z.enum(["noop", "copy"]),
  merge_state: LegacyDB.MergeState,
})

export const DatabaseRoutes = lazy(() =>
  new Hono()
    .get(
      "/legacy/status",
      describeRoute({
        summary: "Scan legacy databases",
        description: "Scan current data directory and report whether the latest legacy database should be copied.",
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
        description: "Get legacy database copy state.",
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
        description: "Mark copy completion state as consumed so restart will not re-show the completion toast.",
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
        summary: "Copy latest legacy database",
        description: "Copy the latest legacy database into aether-prod.db when the target database is missing.",
        operationId: "database.legacy.merge",
        responses: {
          200: {
            description: "Copy result",
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
        if (!status.should_merge) {
          return c.json({
            status,
            mode: "noop",
            merge_state: await LegacyDB.mergeState(),
          })
        }

        try {
          const file = await LegacyDB.copySource()
          return c.json({
            status: await LegacyDB.status(),
            mode: file ? "copy" : "noop",
            merge_state: await LegacyDB.setMergeState({
              state: "done",
              updated: Date.now(),
            }),
          })
        } catch (error) {
          return c.json({
            status,
            mode: "noop",
            merge_state: await LegacyDB.setMergeState({
              state: "error",
              updated: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            }),
          })
        }
      },
    ),
)
