import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { NativeMcpAuth } from "./mcp-auth"

export function NativeMcpAuthRoutes() {
  return new Hono()
    .post(
      "/codex/mcp/login",
      describeRoute({
        summary: "Start Codex-managed OAuth for a configured MCP service",
        operationId: "native.mcpLogin",
        responses: {
          200: {
            description: "MCP authorization progress",
            content: { "application/json": { schema: resolver(NativeMcpAuth.Status) } },
          },
          409: {
            description: "Authorization cannot start",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("json", NativeMcpAuth.Input),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return Promise.resolve()
          .then(() => NativeMcpAuth.start(c.req.valid("json")))
          .then(
            (result) => c.json(result),
            (err: unknown) =>
              c.json({ error: err instanceof Error ? err.message : "MCP sign-in is unavailable." }, 409),
          )
      },
    )
    .get(
      "/codex/mcp/login/:id",
      describeRoute({
        summary: "Read the status of the same MCP authorization attempt",
        operationId: "native.mcpLoginStatus",
        responses: {
          200: {
            description: "MCP authorization progress",
            content: { "application/json": { schema: resolver(NativeMcpAuth.Status) } },
          },
          404: {
            description: "Attempt unavailable in this project",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeMcpAuth.read(c.req.valid("param").id).then(
          (result) => c.json(result),
          () => c.json({ error: "This MCP sign-in is no longer available in this project. Start again." }, 404),
        )
      },
    )
    .delete(
      "/codex/mcp/login/:id",
      describeRoute({
        summary: "Cancel only this MCP authorization connection",
        operationId: "native.cancelMcpLogin",
        responses: {
          200: {
            description: "Final authorization status",
            content: { "application/json": { schema: resolver(NativeMcpAuth.Status) } },
          },
          404: {
            description: "Attempt belongs to another project",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      async (c) => {
        c.header("Cache-Control", "no-store")
        return NativeMcpAuth.cancel(c.req.valid("param").id).then(
          (result) => c.json(result),
          () => c.json({ error: "This MCP sign-in belongs to another project." }, 404),
        )
      },
    )
}
