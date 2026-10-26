import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Codex } from "../../native/codex"
import { NativeSync } from "../../native/sync"
import { SessionID } from "../../session/schema"
import { lazy } from "../../util/lazy"

export const NativeRoutes = lazy(() =>
  new Hono()
    .get(
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
    )
    .post(
      "/codex/:sessionID/history",
      describeRoute({
        summary: "Refresh Codex conversation history",
        description:
          "Read saved native history without resuming the thread. Incomplete reads preserve existing display records.",
        operationId: "native.history",
        responses: {
          200: {
            description: "History refresh status",
            content: { "application/json": { schema: resolver(NativeSync.Status) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator(
        "query",
        z.object({
          refresh: z
            .preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean())
            .optional(),
        }),
      ),
      async (c) => c.json(await NativeSync.refresh(c.req.valid("param").sessionID, c.req.valid("query").refresh)),
    ),
)
