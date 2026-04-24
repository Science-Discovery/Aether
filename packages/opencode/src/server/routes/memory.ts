import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Memory } from "@/memory"

const MemoryResponse = z.object({
  settings: Memory.Settings,
  user: Memory.ReadStore,
  memory: Memory.ReadStore,
  daily: Memory.DailyMemory,
  active: z
    .object({
      session_id: z.string(),
      prompt: z.string(),
      entries: z.array(
        z.object({
          source: Memory.MemoryPoolSource,
          store: Memory.Store.optional(),
          index: z.number(),
          text: z.string(),
        }),
      ),
    })
    .optional(),
})

export const MemoryRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Get memory stores",
      description: "Read effective memory settings, durable stores, and optional session active memory.",
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
      const sessionID = c.req.query("session_id")
      const [set, stores, active] = await Promise.all([
        Memory.settings(),
        Memory.list(),
        sessionID
          ? Memory.activePrompt({ session_id: sessionID }).then((result) => ({
              session_id: sessionID,
              prompt: result.prompt,
              entries: result.active.map((entry) => ({
                source: entry.source,
                store: entry.store,
                index: entry.index,
                text: entry.text,
              })),
            }))
          : undefined,
      ])
      return c.json({
        settings: set,
        user: stores.user,
        memory: stores.memory,
        daily: stores.daily,
        ...(active ? { active } : {}),
      })
    },
  ),
)
