import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Memory } from "@/memory"
import { syncDailyReflectJob } from "@/memory/installer"

const SearchBody = z.object({
  query: z.string().min(1),
  mode: z.enum(["search", "overview"]).optional(),
  types: z.array(z.enum(["preference", "fact", "task"])).optional(),
  limit: z.number().int().optional(),
  currentProjectID: z.string().optional(),
})

const ReflectBody = z.object({
  mode: z.enum(["quick", "daily", "manual"]).optional(),
  reason: z.string().optional(),
})

export const MemoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get memory system status",
        operationId: "memory.status",
        responses: {
          200: {
            description: "Memory status",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      async (c) => c.json(await Memory.status()),
    )
    .post(
      "/search",
      describeRoute({
        summary: "Search long-term memory",
        operationId: "memory.search",
        responses: {
          200: {
            description: "Memory search result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      validator("json", SearchBody),
      async (c) => c.json(await Memory.search(c.req.valid("json"))),
    )
    .post(
      "/reflect",
      describeRoute({
        summary: "Run memory reflection",
        operationId: "memory.reflect",
        responses: {
          200: {
            description: "Memory reflection result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      validator("json", ReflectBody),
      async (c) =>
        c.json(
          await Memory.reflect({
            mode: c.req.valid("json").mode ?? "quick",
            reason: c.req.valid("json").reason,
            signal: c.req.raw.signal,
          }),
        ),
    )
    .post(
      "/initialize/start",
      describeRoute({
        summary: "Start one-time memory initialization",
        operationId: "memory.initialize.start",
        responses: {
          200: {
            description: "Initialization result",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      async (c) => c.json(await Memory.initialize({ confirm: true, signal: c.req.raw.signal })),
    )
    .post(
      "/initialize/cancel",
      describeRoute({
        summary: "Cancel memory initialization",
        operationId: "memory.initialize.cancel",
        responses: {
          200: {
            description: "Cancel result",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
        },
      }),
      async (c) => c.json(await Memory.cancelInitialize()),
    )
    .post(
      "/daily-reflect/sync",
      describeRoute({
        summary: "Sync daily memory reflection cron job from config",
        operationId: "memory.dailyReflect.sync",
        responses: {
          200: {
            description: "Synced cron job",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
        },
      }),
      async (c) => c.json(await syncDailyReflectJob({ preserveExisting: false })),
    ),
)
