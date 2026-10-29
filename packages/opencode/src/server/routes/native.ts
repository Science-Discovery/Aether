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
import { NativeAnswers } from "../../native/answers"
import { NativeQuestion } from "../../native/questions"
import { NativeRevert } from "../../native/revert"
import { NativeAuth } from "../../native/auth"
import { NativeSkills } from "../../native/skills"
import { NativeMcp } from "../../native/mcp"
import { NativeCompactRoutes } from "../../native/compact-routes"
import { NativeChatRoutes } from "../../native/chats-routes"
import { NativeTaskRoutes } from "../../native/tasks-routes"
import { MessageID, SessionID } from "../../session/schema"
import { lazy } from "../../util/lazy"

export const NativeRoutes = lazy(() =>
  new Hono()
    .route("/", NativeCompactRoutes())
    .route("/", NativeChatRoutes())
    .route("/", NativeTaskRoutes())
    .get(
      "/codex/mcp",
      describeRoute({
        summary: "Read native Codex MCP services and tools",
        operationId: "native.mcp",
        responses: {
          200: {
            description: "MCP inventory",
            content: { "application/json": { schema: resolver(NativeMcp.Status) } },
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
      async (c) => c.json(await NativeMcp.read(c.req.valid("query"))),
    )
    .post(
      "/codex/login",
      describeRoute({
        summary: "Start Codex-managed ChatGPT sign-in without running inference",
        operationId: "native.login",
        responses: {
          200: {
            description: "Sign-in progress and browser authorization or device-code instructions",
            content: { "application/json": { schema: resolver(NativeAuth.Status) } },
          },
          409: {
            description: "Another sign-in is already in progress",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("json", NativeAuth.Input),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeAuth.start(c.req.valid("json")).then(
          (result) => c.json(result),
          (error: unknown) =>
            c.json({ error: error instanceof Error ? error.message : "Codex sign-in is unavailable." }, 409),
        )
      },
    )
    .get(
      "/codex/login/:id",
      describeRoute({
        summary: "Read the status of a Codex sign-in attempt",
        operationId: "native.loginStatus",
        responses: {
          200: {
            description: "Current sign-in status",
            content: { "application/json": { schema: resolver(NativeAuth.Status) } },
          },
          404: {
            description: "Sign-in attempt expired or the server restarted",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeAuth.read(c.req.valid("param").id).then(
          (result) => c.json(result),
          () => c.json({ error: "This Codex sign-in is no longer available. Start again." }, 404),
        )
      },
    )
    .delete(
      "/codex/login/:id",
      describeRoute({
        summary: "Cancel only the specified Codex sign-in attempt",
        operationId: "native.cancelLogin",
        responses: {
          200: {
            description: "Final sign-in status",
            content: { "application/json": { schema: resolver(NativeAuth.Status) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return c.json(await NativeAuth.cancel(c.req.valid("param").id))
      },
    )
    .post(
      "/codex/:sessionID/revert/prepare",
      describeRoute({
        summary: "Prepare an edit at a native Codex turn boundary without changing history",
        operationId: "native.prepareRevert",
        responses: {
          200: {
            description: "Prepared operation identity",
            content: { "application/json": { schema: resolver(NativeRevert.Prepared) } },
          },
          409: {
            description: "History cannot be edited",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", NativeRevert.Prepare.pick({ sessionID: true })),
      validator("json", NativeRevert.Prepare.pick({ messageID: true }).strict()),
      async (c) =>
        NativeRevert.prepare({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
          (result) => c.json(result),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    )
    .post(
      "/codex/:sessionID/revert",
      describeRoute({
        summary: "Apply or verify the same prepared Codex history edit without repeating a revert",
        operationId: "native.revert",
        responses: {
          200: {
            description: "Native edit result",
            content: { "application/json": { schema: resolver(NativeRevert.Result) } },
          },
          409: {
            description: "Edit was not dispatched",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", NativeRevert.Commit.pick({ sessionID: true })),
      validator("json", NativeRevert.Commit.pick({ id: true }).strict()),
      async (c) =>
        NativeRevert.commit({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
          (result) => c.json(result),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    )
    .get(
      "/codex/:sessionID/revert",
      describeRoute({
        summary: "Read the durable status of a Codex history edit",
        operationId: "native.revertStatus",
        responses: {
          200: {
            description: "Current edit status, or null before a mutation",
            content: { "application/json": { schema: resolver(NativeRevert.Status.nullable()) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("query", z.object({ operationId: z.string().uuid().optional() })),
      async (c) => c.json(await NativeRevert.status(c.req.valid("param").sessionID, c.req.valid("query").operationId)),
    )
    .get(
      "/codex/:sessionID/questions",
      describeRoute({
        summary: "List unanswered Codex questions across the saved conversation",
        operationId: "native.questions",
        responses: {
          200: {
            description: "Unsubmitted asynchronous questions",
            content: { "application/json": { schema: resolver(NativeAnswers.Pending) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => c.json(await NativeAnswers.pending(c.req.valid("param").sessionID)),
    )
    .post(
      "/codex/:sessionID/questions/:itemID/reply",
      describeRoute({
        summary: "Submit or inspect a durable answer to a Codex asynchronous question",
        operationId: "native.replyQuestion",
        responses: {
          200: {
            description: "Saved question and answer delivery status",
            content: { "application/json": { schema: resolver(NativeQuestion.Info) } },
          },
          409: {
            description: "Answer cannot be submitted",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", NativeAnswers.Input.pick({ sessionID: true, itemID: true })),
      validator("json", NativeAnswers.Input.pick({ threadID: true, answers: true })),
      async (c) =>
        NativeAnswers.reply({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
          (result) => c.json(result),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    )
    .post(
      "/codex/:sessionID/questions/:itemID/skip",
      describeRoute({
        summary: "Submit or inspect an explicit decision not to answer a Codex question group",
        operationId: "native.skipQuestion",
        responses: {
          200: {
            description: "Saved question and skip delivery status",
            content: { "application/json": { schema: resolver(NativeQuestion.Info) } },
          },
          409: {
            description: "Skip cannot be submitted",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", NativeAnswers.Skip.pick({ sessionID: true, itemID: true })),
      validator("json", NativeAnswers.Skip.pick({ threadID: true }).strict()),
      async (c) =>
        NativeAnswers.skip({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
          (result) => c.json(result),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    )
    .get(
      "/codex/skills",
      describeRoute({
        summary: "List enabled Codex skills for this project",
        operationId: "native.skills",
        responses: {
          200: {
            description: "Native skills without running inference",
            content: { "application/json": { schema: resolver(NativeSkills.Status) } },
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
      async (c) => c.json(await NativeSkills.read(c.req.valid("query"))),
    )
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
      "/codex/:sessionID/queue/:messageID/send",
      describeRoute({
        summary: "Send a queued message into the current Codex turn",
        operationId: "native.sendQueued",
        responses: {
          200: {
            description: "Updated queue and native delivery evidence; uncertain input is never replayed",
            content: { "application/json": { schema: resolver(NativeQueue.Sent) } },
          },
          409: {
            description: "Queue delivery could not be resolved",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", NativeQueue.Send.pick({ sessionID: true, messageID: true })),
      validator("json", NativeQueue.Send.pick({ turnID: true })),
      async (c) =>
        NativeQueue.send({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
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
