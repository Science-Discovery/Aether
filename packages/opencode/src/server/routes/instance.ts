import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { ActiveInstance } from "../../project/active-instance"
import { Filesystem } from "../../util/filesystem"
import { lazy } from "../../util/lazy"

const Query = z.object({ directory: z.string() })

export const InstanceRoutes = lazy(() =>
  new Hono()
    .post(
      "/activate",
      describeRoute({
        summary: "Activate an instance",
        description:
          "Signal that the user has navigated to this project/worktree. Triggers deferred heavy services (e.g. FileWatcher) for the directory.",
        operationId: "instance.activate",
        responses: {
          200: {
            description: "Activation acknowledged",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
        },
      }),
      validator("query", Query),
      async (c) => {
        const dir = Filesystem.resolve(c.req.valid("query").directory)
        const active = ActiveInstance.is(dir)
        ActiveInstance.activate(dir)
        if (active) ActiveInstance.replay(dir)
        return c.json({ ok: true })
      },
    )
    .post(
      "/deactivate",
      describeRoute({
        summary: "Deactivate an instance",
        description:
          "Signal that the user has navigated away from this project/worktree. Tears down deferred services (e.g. FileWatcher) for the directory.",
        operationId: "instance.deactivate",
        responses: {
          200: {
            description: "Deactivation acknowledged",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
        },
      }),
      validator("query", Query),
      async (c) => {
        const dir = Filesystem.resolve(c.req.valid("query").directory)
        ActiveInstance.deactivate(dir)
        return c.json({ ok: true })
      },
    ),
)
