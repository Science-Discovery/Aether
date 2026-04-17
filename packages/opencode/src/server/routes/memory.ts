import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Memory } from "@/memory"

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
      description: "Read effective memory settings and both durable stores (USER and MEMORY).",
      operationId: "memory.get",
      responses: {
        200: {
          description: "Memory settings and store snapshots",
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
