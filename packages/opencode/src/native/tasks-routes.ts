import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Session } from "@/session"
import { NativeTasks } from "./tasks"
import { NativeQuestion } from "./questions"

export function NativeTaskRoutes() {
  const error = {
    description: "Task unavailable",
    content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
  }
  return new Hono()
    .get(
      "/codex/:sessionID/tasks",
      describeRoute({
        summary: "Read verified Codex child tasks and their questions",
        operationId: "native.tasks",
        responses: {
          200: { description: "Child tasks", content: { "application/json": { schema: resolver(NativeTasks.List) } } },
          409: error,
        },
      }),
      validator("param", NativeTasks.Input.pick({ sessionID: true })),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeTasks.list(c.req.valid("param").sessionID).then(
          (value) => c.json(value),
          (err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 409),
        )
      },
    )
    .post(
      "/codex/:sessionID/tasks/answer",
      describeRoute({
        summary: "Answer or skip a question in its verified child thread",
        operationId: "native.replyTask",
        responses: {
          200: {
            description: "Answer receipt",
            content: { "application/json": { schema: resolver(NativeQuestion.Info) } },
          },
          409: error,
        },
      }),
      validator("param", NativeTasks.Input.pick({ sessionID: true })),
      validator("json", NativeTasks.Input.omit({ sessionID: true }).strict()),
      async (c) =>
        NativeTasks.reply({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
          (value) => c.json(value),
          (err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 409),
        ),
    )
    .post(
      "/codex/:sessionID/tasks/open",
      describeRoute({
        summary: "Open an idle child task as its own linked Aether chat",
        operationId: "native.openTask",
        responses: {
          200: {
            description: "Linked child chat",
            content: { "application/json": { schema: resolver(Session.Info) } },
          },
          409: error,
        },
      }),
      validator("param", NativeTasks.Input.pick({ sessionID: true })),
      validator("json", NativeTasks.Input.pick({ threadID: true }).strict()),
      async (c) =>
        NativeTasks.attach(c.req.valid("param").sessionID, c.req.valid("json").threadID).then(
          (value) => c.json(value),
          (err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 409),
        ),
    )
}
