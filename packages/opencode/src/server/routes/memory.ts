import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Memory } from "@/memory"

const MemoryResponse = z.object({
  settings: Memory.Settings,
  refresh: Memory.RefreshStatus,
  user: Memory.ReadStore,
  inbox: Memory.ReadStore,
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
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get memory stores",
        description: "Read effective memory settings, durable stores, refresh status, and optional session active memory.",
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
        const [set, stores, active, refresh] = await Promise.all([
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
          Memory.refreshStatus(),
        ])
        return c.json({
          settings: set,
          refresh,
          user: stores.user,
          inbox: stores.inbox,
          memory: stores.memory,
          daily: stores.daily,
          ...(active ? { active } : {}),
        })
      },
    )
    .post(
      "/refresh/dry-run",
      describeRoute({
        summary: "Run memory refresh dry-run",
        description: "Run first-phase memory refresh inventory and source-ledger scan without writing memory.",
        operationId: "memory.refresh.dryRun",
        responses: {
          200: {
            description: "Refresh dry-run status and statistics",
            content: {
              "application/json": {
                schema: resolver(Memory.RefreshDryRun),
              },
            },
          },
        },
      }),
      async (c) => {
        const scope = Memory.RefreshScope.safeParse(c.req.query("scope"))
        return c.json(await Memory.refreshDryRun({ scope: scope.success ? scope.data : undefined }))
      },
    )
    .post(
      "/refresh/run",
      describeRoute({
        summary: "Run memory refresh",
        description: "Run memory refresh/backfill, incrementally by default or fully when force=true.",
        operationId: "memory.refresh.run",
        responses: {
          200: {
            description: "Refresh run status and statistics",
            content: {
              "application/json": {
                schema: resolver(Memory.RefreshRunResult),
              },
            },
          },
        },
      }),
      async (c) => {
        const scope = Memory.RefreshScope.safeParse(c.req.query("scope"))
        return c.json(
          await Memory.refreshRun({
            scope: scope.success ? scope.data : undefined,
            force: c.req.query("force") === "true",
          }),
        )
      },
    ),
)
