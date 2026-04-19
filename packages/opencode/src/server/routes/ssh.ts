import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { errors } from "../error"
import { bootstrap, BootstrapInput, BootstrapOutput, disconnect } from "@/remote-ssh"

export const SshRoutes = lazy(() =>
  new Hono()
    .post(
      "/bootstrap",
      describeRoute({
        summary: "Bootstrap SSH remote server",
        description: "Connect to a remote machine over SSH, install opencode if needed, and expose a local loopback endpoint.",
        operationId: "experimental.ssh.bootstrap",
        responses: {
          200: {
            description: "SSH bootstrap completed",
            content: {
              "application/json": {
                schema: resolver(BootstrapOutput),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", BootstrapInput),
      async (c) => {
        return c.json(await bootstrap(c.req.valid("json")))
      },
    )
    .post(
      "/disconnect",
      describeRoute({
        summary: "Schedule SSH runtime disconnect",
        description: "Mark an SSH runtime idle and schedule cleanup after the grace window.",
        operationId: "experimental.ssh.disconnect",
        responses: {
          200: {
            description: "SSH runtime disconnect scheduled",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ savedHostID: z.string().min(1) })),
      async (c) => {
        return c.json({ ok: await disconnect(c.req.valid("json").savedHostID) })
      },
    ),
)
