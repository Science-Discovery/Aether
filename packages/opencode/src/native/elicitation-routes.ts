import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { NativeElicitation } from "./elicitation"

export function NativeElicitationRoutes() {
  const error = {
    description: "Request unavailable",
    content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
  }
  return new Hono()
    .get(
      "/codex/:sessionID/elicitations",
      describeRoute({
        summary: "Read pending MCP forms on this conversation's execution connection",
        operationId: "native.elicitations",
        responses: {
          200: {
            description: "Pending requests",
            content: { "application/json": { schema: resolver(NativeElicitation.List) } },
          },
          409: error,
        },
      }),
      validator("param", NativeElicitation.Input.pick({ sessionID: true })),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeElicitation.list(c.req.valid("param").sessionID).then(
          (value) => c.json(value),
          (err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 409),
        )
      },
    )
    .post(
      "/codex/:sessionID/elicitations/reply",
      describeRoute({
        summary: "Accept, decline or cancel the originating MCP request",
        operationId: "native.replyElicitation",
        responses: {
          200: {
            description: "Reply receipt",
            content: { "application/json": { schema: resolver(NativeElicitation.Receipt) } },
          },
          409: error,
        },
      }),
      validator("param", NativeElicitation.Input.pick({ sessionID: true })),
      validator("json", NativeElicitation.Input.omit({ sessionID: true }).strict()),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeElicitation.reply({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
          (value) => c.json(value),
          (err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 409),
        )
      },
    )
}
