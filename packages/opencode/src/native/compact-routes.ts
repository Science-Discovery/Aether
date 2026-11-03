import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { NativeCompact } from "./compact"

export function NativeCompactRoutes() {
  return new Hono()
    .post(
      "/codex/:sessionID/compact",
      describeRoute({
        summary: "Compact native Codex context once and await completion",
        operationId: "native.compact",
        responses: {
          200: {
            description: "Compaction result",
            content: { "application/json": { schema: resolver(NativeCompact.Status) } },
          },
          409: {
            description: "Compaction cannot start",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", NativeCompact.Input.pick({ sessionID: true })),
      validator("json", NativeCompact.Input.pick({ id: true }).strict()),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeCompact.start({ ...c.req.valid("param"), ...c.req.valid("json") }).then(
          (value) => c.json(value),
          (error: unknown) => c.json({ error: error instanceof Error ? error.message : String(error) }, 409),
        )
      },
    )
    .get(
      "/codex/:sessionID/compact",
      describeRoute({
        summary: "Read compaction progress or verify uncertain completion without another compact request",
        operationId: "native.compactStatus",
        responses: {
          200: {
            description: "Compaction status",
            content: { "application/json": { schema: resolver(NativeCompact.Status.nullable()) } },
          },
        },
      }),
      validator("param", NativeCompact.Input.pick({ sessionID: true })),
      validator(
        "query",
        z.object({
          operationId: z.string().uuid().optional(),
          refresh: z
            .preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean())
            .optional(),
        }),
      ),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return c.json(
          await NativeCompact.status(
            c.req.valid("param").sessionID,
            c.req.valid("query").refresh,
            c.req.valid("query").operationId,
          ),
        )
      },
    )
}
