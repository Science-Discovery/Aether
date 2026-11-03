import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { NativeImage } from "./image"

export function NativeImageRoutes() {
  return new Hono().get(
    "/codex/:sessionID/message/:messageID/image/:partID",
    describeRoute({
      summary: "Preview a completed Codex image item",
      operationId: "native.image",
      responses: {
        200: { description: "Image preview", content: { "application/json": { schema: resolver(NativeImage.Info) } } },
        409: {
          description: "Image unavailable",
          content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
        },
      },
    }),
    validator("param", NativeImage.Input),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return NativeImage.read(c.req.valid("param")).then(
        (value) => c.json(value),
        (err: unknown) => c.json({ error: err instanceof Error ? err.message : "Codex image unavailable." }, 409),
      )
    },
  )
}
