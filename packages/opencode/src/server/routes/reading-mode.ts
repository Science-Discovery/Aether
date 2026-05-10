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
import { SyncEvent } from "../../sync"
import { PDFDocument } from "pdf-lib"
import { Filesystem } from "../../util/filesystem"
import { Instance } from "../../project/instance"
import { getDocumentProxy } from "unpdf"

function sessionDir(id: string) {
  return path.join(Global.Path.data, "reading-mode", id)
}

function formatCombinedText(pages: Array<{ pageNumber: number; text: string }>) {
  return pages.map((page) => `【第 ${page.pageNumber} 页】\n${page.text}`).join("\n\n")
}

function normalizePageText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

async function extractPageTextRange(pdfStorePath: string, startPage: number, endPage: number) {
  const buffer = await Bun.file(pdfStorePath).arrayBuffer()
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    useSystemFonts: true,
    disableFontFace: true,
    fontExtraProperties: false,
    verbosity: 0,
  })

  try {
    const pageCount = Number(pdf.numPages ?? 0)
    if (pageCount === 0) {
      return {
        pageCount: 0,
        pages: [] as Array<{ pageNumber: number; text: string }>,
        combinedText: "",
      }
    }

    const safeStartPage = Math.max(1, Math.min(pageCount, startPage))
    const safeEndPage = Math.max(safeStartPage, Math.min(pageCount, endPage))

    if (safeStartPage > safeEndPage) {
      throw new Error("invalid page range")
    }

    const pages: Array<{ pageNumber: number; text: string }> = []
    for (let pageNumber = safeStartPage; pageNumber <= safeEndPage; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const text = normalizePageText(
        textContent.items
          .map((item) => (typeof item === "object" && item && "str" in item ? String(item.str ?? "") : ""))
          .join(" "),
      )
      pages.push({ pageNumber, text })
      page.cleanup?.()
    }

    return {
      pageCount,
      pages,
      combinedText: pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join("\n\n"),
    }
  } finally {
    await pdf.destroy?.()
  }
}

/** Write readingMode + title directly to DB to avoid SyncEvent async timing issues. */
async function persistReadingMeta(id: string, meta: ReadingMode.SessionMeta, title: string) {
  Database.useProject(Instance.project.id, (db) =>
    db
      .update(SessionTable)
      .set({ reading_mode: meta, title })
      .where(eq(SessionTable.id, id as any))
      .run(),
  )
  SyncEvent.run(Session.Event.Updated, {
    sessionID: id as any,
    info: {
      title,
      readingMode: meta,
    },
  })
}

const ReadingModeFromFileResponse = z.object({
  action: z.union([z.literal("existing"), z.literal("created")]),
  session: Session.Info,
})

function resolveReadingSettings(input?: string | Partial<ReadingMode.Settings>) {
  if (!input) return { ...ReadingMode.DEFAULT_SETTINGS }
  if (typeof input === "string") {
    try {
      return { ...ReadingMode.DEFAULT_SETTINGS, ...(JSON.parse(input) as Partial<ReadingMode.Settings>) }
    } catch {
      return { ...ReadingMode.DEFAULT_SETTINGS }
    }
  }
  return { ...ReadingMode.DEFAULT_SETTINGS, ...input }
}

function resolveWorkspacePdfPath(inputPath: string) {
  const workspaceDirectory = Filesystem.resolve(Instance.directory)
  const resolvedPath = Filesystem.resolve(
    path.isAbsolute(inputPath) ? inputPath : path.join(workspaceDirectory, inputPath),
  )
  if (resolvedPath !== workspaceDirectory && !Filesystem.contains(workspaceDirectory, resolvedPath)) {
    throw new Error("path must stay within workspace directory")
  }
  return resolvedPath
}

async function buildPagePdfResponse(input: {
  sourceBytes: Buffer
  pdfFileName: string
  startPage: number
  endPage: number
}) {
  const source = await PDFDocument.load(input.sourceBytes)
  const pageCount = source.getPageCount()
  if (pageCount === 0) {
    return { error: "pdf has no pages", status: 400 as const }
  }

  if (input.startPage > pageCount || input.endPage > pageCount) {
    return { error: "page range out of bounds", status: 400 as const }
  }

  const output = await PDFDocument.create()
  const indices = Array.from({ length: input.endPage - input.startPage + 1 }, (_, index) => input.startPage - 1 + index)
  const pages = await output.copyPages(source, indices)
  for (const page of pages) output.addPage(page)

  const pdfBytes = await output.save()
  const pdfArrayBuffer = new ArrayBuffer(pdfBytes.byteLength)
  new Uint8Array(pdfArrayBuffer).set(pdfBytes)
  const pdfBlob = new Blob([pdfArrayBuffer], { type: "application/pdf" })
  const baseName = path.basename(input.pdfFileName, ".pdf") || "document"
  const filename = `${baseName}-pages-${input.startPage}-${input.endPage}.pdf`

  return new Response(pdfBlob, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  })
}

async function createReadingSession(input: {
  pdfFileName: string
  settings: ReadingMode.Settings
  source: ReadingMode.Source
  writePdf: (targetPath: string) => Promise<void>
}) {
  const session = await Session.create({})
  const dir = sessionDir(session.id)
  await fs.mkdir(dir, { recursive: true })

  const pdfStorePath = path.join(dir, "original.pdf")
  await input.writePdf(pdfStorePath)

  const annotationsPath = path.join(dir, "annotations.json")
  await AnnotationStore.write(annotationsPath, {
    version: "1.0",
    pdfStorePath,
    annotations: [],
    bookmarks: [],
    lastReadPage: 1,
  })

  const baseName = path.basename(input.pdfFileName, ".pdf")
  const meta: ReadingMode.SessionMeta = {
    pdfFileName: input.pdfFileName,
    pdfStorePath,
    lastReadPage: 1,
    annotationsPath,
    source: input.source,
    settings: input.settings,
    firstReadCompleted: false,
    firstReadDismissed: false,
  }

  await persistReadingMeta(session.id, meta, `PDF ${baseName}`)
  return Session.get(session.id)
}

async function findLatestReadingSessionByPath(sourcePath: string) {
  for (const session of Session.list({
    directory: Instance.directory,
    roots: true,
    limit: 1000,
  })) {
    if (session.readingMode?.source.kind !== "workspace-file") continue
    if (session.readingMode.source.path !== sourcePath) continue
    return session
  }
  return undefined
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

        const settingsInput = body["settings"] as string | undefined
        const settings = resolveReadingSettings(settingsInput)

        const pdfFileName = file.name || "document.pdf"
        const buf = await file.arrayBuffer()
        const session = await createReadingSession({
          pdfFileName,
          settings,
          source: { kind: "upload" },
          writePdf: async (targetPath) => {
            await fs.writeFile(targetPath, Buffer.from(buf))
          },
        })
        return c.json(session)
      },
    )

    .post(
      "/session/from-file",
      describeRoute({
        summary: "Open reading mode from a workspace PDF file",
        operationId: "reading-mode.session.from-file",
        responses: {
          200: {
            description: "Existing or newly created reading mode session",
            content: { "application/json": { schema: resolver(ReadingModeFromFileResponse) } },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          settings: z
            .object({
              translatePrompt: z.string().optional(),
              questionPrompt: z.string().optional(),
              firstReadPrompt: z.string().optional(),
              contextPageRange: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
              autoFirstRead: z.boolean().optional(),
            })
            .optional(),
          forceNew: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        let resolvedPath: string
        try {
          resolvedPath = resolveWorkspacePdfPath(body.path)
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : "invalid path" }, 400)
        }

        const stats = await fs.stat(resolvedPath).catch(() => undefined)
        if (!stats?.isFile()) return c.json({ error: "pdf not found" }, 404)
        if (path.extname(resolvedPath).toLowerCase() !== ".pdf") {
          return c.json({ error: "path must reference a PDF file" }, 400)
        }

        if (!body.forceNew) {
          const existing = await findLatestReadingSessionByPath(resolvedPath)
          if (existing) {
            return c.json({
              action: "existing" as const,
              session: existing,
            })
          }
        }

        const session = await createReadingSession({
          pdfFileName: path.basename(resolvedPath),
          settings: resolveReadingSettings(body.settings),
          source: {
            kind: "workspace-file",
            path: resolvedPath,
          },
          writePdf: async (targetPath) => {
            await fs.copyFile(resolvedPath, targetPath)
          },
        })

        return c.json({
          action: "created" as const,
          session,
        })
      },
    )

    .post(
      "/page-text",
      describeRoute({
        summary: "Get extracted text for reading mode PDF pages",
        operationId: "reading-mode.page-text",
        responses: {
          200: {
            description: "Extracted page text",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    pageCount: z.number().int().nonnegative(),
                    pages: z.array(
                      z.object({
                        pageNumber: z.number().int().positive(),
                        text: z.string(),
                      }),
                    ),
                    combinedText: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          sessionID: SessionID.zod,
          startPage: z.number().int().positive(),
          endPage: z.number().int().positive(),
        }),
      ),
      async (c) => {
        const { sessionID, startPage, endPage } = c.req.valid("json")
        if (startPage > endPage) return c.json({ error: "invalid page range" }, 400)

        const session = await Session.get(sessionID)
        if (!session.readingMode) return c.json({ error: "not a reading mode session" }, 400)

        try {
          return c.json(await extractPageTextRange(session.readingMode.pdfStorePath, startPage, endPage))
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : "failed to parse pdf" }, 400)
        }
      },
    )

    .post(
      "/page-pdf",
      describeRoute({
        summary: "Get a ranged PDF subdocument for reading mode",
        operationId: "reading-mode.page-pdf",
        responses: {
          200: {
            description: "PDF binary for the requested page range",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          sessionID: SessionID.zod,
          startPage: z.number().int().positive(),
          endPage: z.number().int().positive(),
        }),
      ),
      async (c) => {
        const { sessionID, startPage, endPage } = c.req.valid("json")
        if (startPage > endPage) return c.json({ error: "invalid page range" }, 400)

        const session = await Session.get(sessionID)
        if (!session.readingMode) return c.json({ error: "not a reading mode session" }, 400)

        let sourceBytes: Buffer
        try {
          sourceBytes = await fs.readFile(session.readingMode.pdfStorePath)
        } catch {
          return c.json({ error: "pdf not found" }, 404)
        }

        try {
          const response = await buildPagePdfResponse({
            sourceBytes,
            pdfFileName: session.readingMode.pdfFileName,
            startPage,
            endPage,
          })
          if ("error" in response) {
            return c.json({ error: response.error }, response.status)
          }
          return response
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : "failed to build page pdf" }, 400)
        }
      },
    )

    .post(
      "/page-pdf-from-file",
      describeRoute({
        summary: "Get a ranged PDF subdocument for a workspace file",
        operationId: "reading-mode.page-pdf-from-file",
        responses: {
          200: {
            description: "PDF binary for the requested page range",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          startPage: z.number().int().positive(),
          endPage: z.number().int().positive(),
        }),
      ),
      async (c) => {
        const { path: pdfPath, startPage, endPage } = c.req.valid("json")
        if (startPage > endPage) return c.json({ error: "invalid page range" }, 400)

        let resolvedPath: string
        try {
          resolvedPath = resolveWorkspacePdfPath(pdfPath)
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : "invalid path" }, 400)
        }

        const stats = await fs.stat(resolvedPath).catch(() => undefined)
        if (!stats?.isFile()) return c.json({ error: "pdf not found" }, 404)
        if (path.extname(resolvedPath).toLowerCase() !== ".pdf") {
          return c.json({ error: "path must reference a PDF file" }, 400)
        }

        let sourceBytes: Buffer
        try {
          sourceBytes = await fs.readFile(resolvedPath)
        } catch {
          return c.json({ error: "pdf not found" }, 404)
        }

        try {
          const response = await buildPagePdfResponse({
            sourceBytes,
            pdfFileName: path.basename(resolvedPath),
            startPage,
            endPage,
          })
          if ("error" in response) {
            return c.json({ error: response.error }, response.status)
          }
          return response
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : "failed to build page pdf" }, 400)
        }
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
          200: {
            description: "OK",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
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
          firstReadDismissed: z.boolean().optional(),
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
          ...(patch.firstReadDismissed !== undefined && { firstReadDismissed: patch.firstReadDismissed }),
        }
        await persistReadingMeta(sessionID, updated, session.title)
        return c.json(await Session.get(sessionID))
      },
    ),
)
