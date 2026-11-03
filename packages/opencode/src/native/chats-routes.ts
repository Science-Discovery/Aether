import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Session } from "@/session"
import { NativeChats } from "./chats"

export function NativeChatRoutes() {
  return new Hono()
    .get(
      "/codex/chats",
      describeRoute({
        summary: "List saved Codex chats in the current project without resuming them",
        operationId: "native.chats",
        responses: {
          200: { description: "Native chats", content: { "application/json": { schema: resolver(NativeChats.Page) } } },
          409: {
            description: "Native chats unavailable",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("query", NativeChats.Query),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeChats.list(c.req.valid("query")).then(
          (value) => c.json(value),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        )
      },
    )
    .post(
      "/codex/chats/attach",
      describeRoute({
        summary: "Link an existing Codex chat to this Aether project without copying its native history",
        operationId: "native.attachChat",
        responses: {
          200: {
            description: "Linked Aether session",
            content: { "application/json": { schema: resolver(Session.Info) } },
          },
          409: {
            description: "Chat cannot be linked",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("json", NativeChats.Input),
      async (c) =>
        NativeChats.attach(c.req.valid("json")).then(
          (value) => c.json(value),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        ),
    )
}
