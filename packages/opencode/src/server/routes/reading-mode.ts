import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import fs from "fs/promises"
import path from "path"
import { Session } from "../../session"
import { SessionID } from "@/session/schema"
import { Global } from "../../global"
import { AnnotationStore } from "../../reading-mode/annotation-store"
import { ReadingMode } from "../../reading-mode/types"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { Database, eq } from "../../storage/db"
import { SessionTable } from "../../session/session.sql"

function sessionDir(id: string) {
  return path.join(Global.Path.data, "reading-mode", id)
}

/** Write readingMode + title directly to DB to avoid SyncEvent async timing issues. */
async function persistReadingMeta(id: string, meta: ReadingMode.SessionMeta, title: string) {
  Database.use((db) =>
    db
      .update(SessionTable)
      .set({ reading_mode: meta, title })
      .where(eq(SessionTable.id, id as any))
      .run(),
  )
}

export const ReadingModeRoutes = lazy(() =>
  new Hono()
    // POST /reading-mode/session — create a reading mode session
    .post(
      "/session",
      describeRoute({
        summary: "Create reading mode session",
        operationId: "reading-mode.session.create",
        responses: {
          200: {
            description: "Created session info with readingMode meta",
            content: { "application/json": { schema: resolver(Session.Info) } },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const body = await c.req.parseBody()
        const file = body["pdf"] as File | undefined
        if (!file || !(file instanceof File)) return c.json({ error: "pdf file required" }, 400)

        const settingsRaw = body["settings"] as string | undefined
        let settings: ReadingMode.Settings = { ...ReadingMode.DEFAULT_SETTINGS }
        if (settingsRaw) {
          try {
            settings = { ...settings, ...(JSON.parse(settingsRaw) as Partial<ReadingMode.Settings>) }
          } catch {}
        }

        const session = await Session.create({})
        const dir = sessionDir(session.id)
        await fs.mkdir(dir, { recursive: true })

        // Always store as "original.pdf" to avoid CJK/special char path issues
        const pdfFileName = file.name || "document.pdf"
        const pdfStorePath = path.join(dir, "original.pdf")
        const buf = await file.arrayBuffer()
        await fs.writeFile(pdfStorePath, Buffer.from(buf))

        const annotationsPath = path.join(dir, "annotations.json")
        await AnnotationStore.write(annotationsPath, {
          version: "1.0",
          pdfStorePath,
          annotations: [],
          bookmarks: [],
          lastReadPage: 1,
        })

        const baseName = path.basename(pdfFileName, ".pdf")
        const meta: ReadingMode.SessionMeta = {
          pdfFileName,
          pdfStorePath,
          lastReadPage: 1,
          annotationsPath,
          settings,
          firstReadCompleted: false,
        }

        // Write directly to DB so the response already has readingMode set
        await persistReadingMeta(session.id, meta, `📖 ${baseName}`)

        return c.json(await Session.get(session.id))
      },
    )

    // GET /reading-mode/annotations?sessionID=xxx
    .get(
      "/annotations",
      describeRoute({
        summary: "Get reading mode annotations",
        operationId: "reading-mode.annotations.get",
        responses: {
          200: {
            description: "Annotation file content",
            content: { "application/json": { schema: resolver(z.unknown()) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("query", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const { sessionID } = c.req.valid("query")
        const session = await Session.get(sessionID)
        if (!session.readingMode) return c.json({ error: "not a reading mode session" }, 400)
        return c.json(await AnnotationStore.read(session.readingMode.annotationsPath))
      },
    )

    // PUT /reading-mode/annotations — update annotations
    .put(
      "/annotations",
      describeRoute({
        summary: "Update reading mode annotations",
        operationId: "reading-mode.annotations.update",
        responses: {
          200: { description: "OK", content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } } },
          ...errors(400, 404),
        },
      }),
      validator("json", z.object({ sessionID: SessionID.zod, data: z.unknown() })),
      async (c) => {
        const body = c.req.valid("json")
        const session = await Session.get(body.sessionID)
        if (!session.readingMode) return c.json({ error: "not a reading mode session" }, 400)
        const data = body.data as ReadingMode.AnnotationFile
        await AnnotationStore.write(session.readingMode.annotationsPath, data)
        if (typeof data.lastReadPage === "number") {
          await persistReadingMeta(
            body.sessionID,
            { ...session.readingMode, lastReadPage: data.lastReadPage },
            session.title,
          )
        }
        return c.json({ ok: true })
      },
    )

    // GET /reading-mode/pdf?sessionID=xxx — serve the stored PDF as binary
    .get(
      "/pdf",
      describeRoute({
        summary: "Get stored PDF file",
        operationId: "reading-mode.pdf.get",
        responses: {
          200: { description: "PDF binary" },
          ...errors(400, 404),
        },
      }),
      validator("query", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const { sessionID } = c.req.valid("query")
        const session = await Session.get(sessionID)
        if (!session.readingMode) return c.json({ error: "not a reading mode session" }, 400)
        try {
          const buf = await fs.readFile(session.readingMode.pdfStorePath)
          return new Response(buf.buffer as ArrayBuffer, {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `inline; filename="${encodeURIComponent(session.readingMode.pdfFileName)}"`,
            },
          })
        } catch {
          return c.json({ error: "pdf not found" }, 404)
        }
      },
    )

    // PATCH /reading-mode/session/:sessionID — update settings
    .patch(
      "/session/:sessionID",
      describeRoute({
        summary: "Update reading mode session settings",
        operationId: "reading-mode.session.update",
        responses: {
          200: { description: "Updated session", content: { "application/json": { schema: resolver(Session.Info) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator(
        "json",
        z.object({
          settings: z
            .object({
              translatePrompt: z.string().optional(),
              questionPrompt: z.string().optional(),
              firstReadPrompt: z.string().optional(),
              contextPageRange: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
              autoFirstRead: z.boolean().optional(),
            })
            .optional(),
          firstReadCompleted: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const patch = c.req.valid("json")
        const session = await Session.get(sessionID)
        if (!session.readingMode) return c.json({ error: "not a reading mode session" }, 400)
        const updated: ReadingMode.SessionMeta = {
          ...session.readingMode,
          ...(patch.settings && { settings: { ...session.readingMode.settings, ...patch.settings } }),
          ...(patch.firstReadCompleted !== undefined && { firstReadCompleted: patch.firstReadCompleted }),
        }
        await persistReadingMeta(sessionID, updated, session.title)
        return c.json(await Session.get(sessionID))
      },
    ),
)
