import { Hono } from "hono"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { detect, list, read } from "../../migrate"
import { sourceFormats } from "../../migrate/model"
import { buildBackup } from "../../migrate/target"
import { InstanceBootstrap } from "../../project/bootstrap"
import { Session } from "../../session"
import { SessionID } from "../../session/schema"
import { Instance } from "../../project/instance"
import { importSessionBackup, linkSubagent } from "../../session/backup"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

const Source = z.enum(sourceFormats)

const SourceInfo = z.object({
  id: Source,
  name: z.string(),
  sessions: z.number().optional(),
})

const SessionInfo = z.object({
  source: Source,
  id: z.string(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  parentID: z.string().optional(),
  updated: z.number().optional(),
})

const ImportInput = z.object({
  source: Source,
  sessionID: z.string().min(1),
  parentSessionID: z.string().min(1).optional(),
})

const ImportResult = z.object({
  sessionID: z.string(),
  title: z.string(),
  directory: z.string(),
  fallback: z.boolean(),
  parentID: z.string().optional(),
  linked: z.boolean().optional(),
  manifest: z.record(z.string(), z.unknown()),
})

const Query = z.object({
  source: Source,
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

function reason(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object" && "message" in data && typeof (data as { message?: unknown }).message === "string") {
      return (data as { message: string }).message
    }
  }
  return error instanceof Error ? error.message : String(error)
}

export const MigrateRoutes = lazy(() =>
  new Hono()
    .get(
      "/sources",
      describeRoute({
        summary: "Detect importable AI apps",
        description: "Detect supported AI apps with local session data and return their session counts.",
        operationId: "migrate.sources",
        responses: {
          200: {
            description: "Detected sources",
            content: {
              "application/json": {
                schema: resolver(z.array(SourceInfo)),
              },
            },
          },
        },
      }),
      async (c) => {
        const found = await detect({ cwd: Instance.directory })
        return c.json(
          found.map((item) => ({
            id: item.id,
            name: item.name,
            sessions: item.sessions,
          })),
        )
      },
    )
    .get(
      "/sessions",
      describeRoute({
        summary: "List importable sessions",
        description: "List session metadata for one detected AI app without reading conversation bodies.",
        operationId: "migrate.sessions",
        responses: {
          200: {
            description: "Importable sessions",
            content: {
              "application/json": {
                schema: resolver(z.array(SessionInfo)),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", Query),
      async (c) => {
        const query = c.req.valid("query")
        const refs = await list(query.source, { cwd: Instance.directory }, { limit: query.limit ?? 100, titles: true })
        return c.json(
          refs.map((item) => ({
            source: item.source,
            id: item.id,
            title: item.title,
            cwd: item.cwd,
            parentID: item.parentID,
            updated: item.updated,
          })),
        )
      },
    )
    .post(
      "/import",
      describeRoute({
        summary: "Import a session from another AI app",
        description: "Convert one source session and import it into the current Aether project.",
        operationId: "migrate.import",
        responses: {
          200: {
            description: "Imported session",
            content: {
              "application/json": {
                schema: resolver(ImportResult),
              },
            },
          },
          ...errors(400, 409),
        },
      }),
      validator("json", ImportInput),
      async (c) => {
        const input = c.req.valid("json")
        try {
          const session = await read(input.source, {
            id: input.sessionID,
            ctx: { cwd: Instance.directory },
          })
          const parent = input.parentSessionID
            ? await Session.getGlobal(SessionID.make(input.parentSessionID)).catch(() => undefined)
            : undefined
          if (input.parentSessionID && !parent) {
            return c.json({ error: "Parent session not found" }, 400)
          }
          const sourceDir = session.cwd ? resolve(session.cwd) : undefined
          const target = parent
            ? parent.directory
            : sourceDir && (await isDirectory(sourceDir))
              ? sourceDir
              : Instance.directory
          const built = buildBackup(session, { directory: target })
          const title = built.manifest.title ?? "Imported subagent session"
          const execute = async () => {
            const imported = await importSessionBackup(
              built.backup,
              c.req.raw.signal,
              parent ? { parentID: parent.id, title } : undefined,
            )
            const linked = parent
              ? await linkSubagent({
                  parentID: parent.id,
                  childID: imported.sessionID,
                  title,
                  agent: session.parentActivity?.agent ?? "general",
                  anchor: session.parentActivity?.timestamp,
                }).catch(() => false)
              : false
            return { imported, linked }
          }
          const result =
            target === Instance.directory
              ? await execute()
              : await Instance.provide({ directory: target, init: InstanceBootstrap, fn: execute })
          return c.json({
            ...result.imported,
            directory: target,
            fallback: !parent && target !== sourceDir,
            parentID: parent?.id,
            linked: parent ? result.linked : undefined,
            manifest: built.manifest,
          })
        } catch (error) {
          return c.json({ error: reason(error) }, 400)
        }
      },
    ),
)

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
