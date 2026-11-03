import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { SessionID } from "@/session/schema"
import { NativeOwnership } from "./ownership"

export function NativeOwnershipRoutes() {
  return new Hono().post(
    "/codex/:sessionID/release",
    describeRoute({
      summary: "Release this idle Aether execution process for use by another Codex client",
      operationId: "native.release",
      responses: {
        200: {
          description: "Whether an idle Aether process was released; no external client was contacted",
          content: { "application/json": { schema: resolver(z.object({ released: z.boolean() })) } },
        },
        409: {
          description: "The conversation has unfinished local work",
          content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
        },
      },
    }),
    validator("param", z.object({ sessionID: SessionID.zod })),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return NativeOwnership.release(c.req.valid("param").sessionID).then(
        (value) => c.json(value),
        (err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 409),
      )
    },
  )
}
