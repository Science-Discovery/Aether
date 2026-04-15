import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { lazy } from "@/util/lazy"
import { Memory } from "@/memory"
import z from "zod"

const MemoryResponse = z.object({
  settings: Memory.Settings,
  user: Memory.ReadStore,
  memory: Memory.ReadStore,
})

export const MemoryRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Get memory stores",
      description: "Read effective memory settings and both durable memory stores.",
      operationId: "memory.get",
      responses: {
        200: {
          description: "Memory settings and stores",
          content: {
            "application/json": {
              schema: resolver(MemoryResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      const [set, stores] = await Promise.all([Memory.settings(), Memory.list()])
      return c.json({
        settings: set,
        user: stores.user,
        memory: stores.memory,
      })
    },
  ),
)
