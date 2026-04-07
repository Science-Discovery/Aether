import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { lazy } from "@/util/lazy"
import { LegacyDB } from "@/storage/legacy-db"
import z from "zod"
import { LegacyRepair } from "@/automation/legacy-repair"

const MergeInput = z
  .object({
    session: z.boolean().default(false),
    mode: LegacyRepair.Mode.default("auto"),
  })
  .optional()

const MergeOutput = z.object({
  status: LegacyDB.Status,
  merge: LegacyDB.Merge,
  sessionID: LegacyRepair.Output.shape.sessionID.optional(),
  fallback: LegacyRepair.Output,
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
    .post(
      "/legacy/merge",
      describeRoute({
        summary: "Merge legacy databases",
        description: "Merge all legacy databases into opencode-prod.db without moving source files.",
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
        const body = MergeInput.parse(await c.req.json().catch(() => undefined))
        const status = await LegacyDB.status()
        const merge = await LegacyDB.merge()
        const fallback = await LegacyRepair.start({
          mode: body?.mode ?? "auto",
          force: body?.session ?? false,
          status,
          merge,
        })
        return c.json({
          status,
          merge,
          sessionID: fallback.sessionID,
          fallback,
        })
      },
    ),
)
