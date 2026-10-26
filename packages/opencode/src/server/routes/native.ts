import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Codex } from "../../native/codex"
import { lazy } from "../../util/lazy"

export const NativeRoutes = lazy(() =>
  new Hono().get(
    "/codex",
    describeRoute({
      summary: "Inspect the native Codex agent",
      description:
        "Discover Codex on the server and inspect its protocol, account status and model catalog without running inference.",
      operationId: "native.status",
      responses: {
        200: {
          description: "Codex installation and connection status",
          content: { "application/json": { schema: resolver(Codex.Status) } },
        },
      },
    }),
    validator(
      "query",
      z.object({
        refresh: z
          .preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean())
          .optional(),
      }),
    ),
    async (c) => {
      const config = await Config.getGlobal()
      return c.json(
        await Codex.status(config.native?.codex?.path, {
          enabled: config.native?.codex?.enabled,
          refresh: c.req.valid("query").refresh,
        }),
      )
    },
  ),
)
