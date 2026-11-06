import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Engines } from "../../engine"
import { Engine } from "../../engine/schema"
import { lazy } from "../../util/lazy"

export const EngineRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List agent engines",
        operationId: "engine.list",
        responses: {
          200: {
            description: "Installed ACP and Claude Code agent engines",
            content: { "application/json": { schema: resolver(z.array(Engine.Status)) } },
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
      async (c) => c.json(await Engines.status(c.req.valid("query").refresh === true)),
    )
    .get(
      "/:id/config",
      describeRoute({
        summary: "Read an engine's models and configuration options",
        operationId: "engine.config",
        responses: {
          200: {
            description: "Models and configurable options",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    models: z.array(Engine.Model).optional(),
                    config: z.array(Engine.Config).optional(),
                    error: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({ id: Engine.ID }),
      ),
      validator("query", z.object({ model: z.string().trim().min(1).max(200).optional() })),
      async (c) => c.json(await Engines.inspect(c.req.valid("param").id, c.req.valid("query").model)),
    ),
)
