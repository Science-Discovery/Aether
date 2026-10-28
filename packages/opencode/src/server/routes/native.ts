import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Codex } from "../../native/codex"
import { NativeSync } from "../../native/sync"
import { Native } from "../../native/schema"
import { NativeSession } from "../../native/session"
import { NativeQueue } from "../../native/queue"
import { NativeUsage } from "../../native/usage"
import { MessageID, SessionID } from "../../session/schema"
import { lazy } from "../../util/lazy"

export const NativeRoutes = lazy(() =>
  new Hono()
    .get(
      "/codex/usage",
      describeRoute({
        summary: "Read Codex account limits",
        operationId: "native.usage",
        responses: {
          200: {
            description: "Account limits, without running inference",
            content: { "application/json": { schema: resolver(NativeUsage.Status) } },
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
      async (c) => c.json(await NativeUsage.read(c.req.valid("query"))),
    )
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
    )
    .get(
      "/codex/:sessionID/runtime",
      describeRoute({
        summary: "Read the Aether-owned Codex run and pending queue",
        operationId: "native.runtime",
        responses: {
          200: {
            description: "Local execution state; not Desktop ownership",
            content: {
              "application/json": {
                schema: resolver(z.object({ active: Native.Active.nullable(), queue: NativeQueue.Status })),
              },
            },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const id = c.req.valid("param").sessionID
        return c.json(
          await NativeQueue.home(id, async () => ({
            active: NativeSession.active(id) ?? null,
            queue: await NativeQueue.list(id),
          })),
        )
      },
    )
    .post(
      "/codex/:sessionID/steer",
      describeRoute({
        summary: "Append text to the current Aether-owned Codex turn",
        operationId: "native.steer",
        responses: {
          200: {
            description: "Delivery evidence; uncertain requests must not be replayed",
            content: { "application/json": { schema: resolver(Native.Steered) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("json", Native.Steer.omit({ sessionID: true })),
      async (c) => {
        const id = c.req.valid("param").sessionID
        return c.json(await NativeQueue.home(id, () => NativeSession.steer({ ...c.req.valid("json"), sessionID: id })))
      },
    )
    .post(
      "/codex/:sessionID/queue",
      describeRoute({
        summary: "Queue a text message after the current Codex task",
        operationId: "native.enqueue",
        responses: {
          200: {
            description: "Durable pending input",
            content: { "application/json": { schema: resolver(NativeQueue.Status) } },
          },
          409: {
            description: "Queue cannot accept this input",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("json", NativeQueue.Input.omit({ sessionID: true })),
      async (c) =>
        NativeQueue.enqueue({ ...c.req.valid("json"), sessionID: c.req.valid("param").sessionID }).then(
          (result) => c.json(result),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    )
    .delete(
      "/codex/:sessionID/queue/:messageID",
      describeRoute({
        summary: "Remove a queued message without resending it",
        operationId: "native.dequeue",
        responses: {
          200: {
            description: "Updated queue",
            content: { "application/json": { schema: resolver(NativeQueue.Status) } },
          },
          409: {
            description: "Message is already dispatching",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod, messageID: MessageID.zod })),
      async (c) =>
        NativeQueue.remove(c.req.valid("param").sessionID, c.req.valid("param").messageID).then(
          (result) => c.json(result),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    )
    .post(
      "/codex/:sessionID/queue/resume",
      describeRoute({
        summary: "Resume pending Codex messages after reviewing a paused queue",
        operationId: "native.resumeQueue",
        responses: {
          200: {
            description: "Queue state",
            content: { "application/json": { schema: resolver(NativeQueue.Status) } },
          },
          409: {
            description: "Unresolved messages require review",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) =>
        NativeQueue.resume(c.req.valid("param").sessionID).then(
          (result) => c.json(result),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    ),
)
