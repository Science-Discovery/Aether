import path from "node:path"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { Latex, LatexSchema } from "../../latex"
import { LatexSetup } from "../../latex/setup"
import { PdfAnnotations } from "../../pdf-annotations"
import { AsyncQueue } from "../../util/queue"
import { lazy } from "../../util/lazy"

const response = (schema: z.ZodType) => ({
  200: { description: "LaTeX result", content: { "application/json": { schema: resolver(schema) } } },
})
const failure = {
  400: { description: "Invalid project or request" },
  404: { description: "Build or artifact not found" },
  409: { description: "Project changed or build already running" },
  413: { description: "Project exceeds snapshot limits" },
  503: { description: "Compiler unavailable" },
}

export const LatexRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        operationId: "latex.status",
        summary: "Inspect local LaTeX compilers",
        responses: { ...response(LatexSchema.Status), ...failure },
      }),
      async (c) => c.json(await Latex.status()),
    )
    .get(
      "/setup",
      describeRoute({
        operationId: "latex.setupStatus",
        summary: "Read the local Tectonic installation state without starting a download",
        responses: { ...response(LatexSchema.Setup), ...failure },
      }),
      async (c) => c.json(await LatexSetup.status()),
    )
    .post(
      "/setup",
      describeRoute({
        operationId: "latex.setupStart",
        summary: "Download and configure the verified Tectonic release on this server",
        responses: { ...response(LatexSchema.Setup), ...failure },
      }),
      async (c) => c.json(await LatexSetup.start()),
    )
    .post(
      "/setup/cancel",
      describeRoute({
        operationId: "latex.setupCancel",
        summary: "Cancel the current Tectonic setup without changing a previous installation",
        responses: { ...response(LatexSchema.Setup), ...failure },
      }),
      async (c) => c.json(await LatexSetup.cancel()),
    )
    .get(
      "/project",
      describeRoute({
        operationId: "latex.project",
        summary: "Resolve a LaTeX main document and its saved binding",
        responses: { ...response(LatexSchema.Project), ...failure },
      }),
      validator("query", z.object({ path: z.string().optional(), root: z.string().optional() })),
      async (c) => c.json(await Latex.inspect(c.req.valid("query"))),
    )
    .put(
      "/project",
      describeRoute({
        operationId: "latex.bind",
        summary: "Bind a LaTeX project to its main document",
        responses: { ...response(LatexSchema.Project), ...failure },
      }),
      validator("json", LatexSchema.Selection),
      async (c) => c.json(await Latex.bind(c.req.valid("json"))),
    )
    .post(
      "/project/refresh",
      describeRoute({
        operationId: "latex.refresh",
        summary: "Hash saved project files and recheck preview freshness",
        responses: { ...response(LatexSchema.Project), ...failure },
      }),
      validator("json", LatexSchema.Refresh),
      async (c) => c.json(await Latex.refresh(c.req.valid("json"))),
    )
    .post(
      "/build",
      describeRoute({
        operationId: "latex.build",
        summary: "Compile a saved LaTeX project asynchronously",
        responses: {
          202: {
            description: "Build accepted",
            content: { "application/json": { schema: resolver(LatexSchema.Build) } },
          },
          ...failure,
        },
      }),
      validator("json", LatexSchema.Start),
      async (c) => c.json(await Latex.start(c.req.valid("json")), 202),
    )
    .get(
      "/versions",
      describeRoute({
        operationId: "latex.versions",
        summary: "List immutable PDF builds and their retention state",
        responses: { ...response(LatexSchema.Version.array()), ...failure },
      }),
      validator("query", z.object({ root: z.string() })),
      async (c) => c.json(await Latex.list(c.req.valid("query"))),
    )
    .post(
      "/versions/cleanup",
      describeRoute({
        operationId: "latex.cleanup",
        summary: "Keep recent builds and all annotated, referenced or viewed PDFs",
        responses: { ...response(LatexSchema.Cleanup), ...failure },
      }),
      validator("json", z.object({ root: z.string() })),
      async (c) => c.json(await Latex.cleanup(c.req.valid("json"))),
    )
    .get(
      "/build/:id/annotations",
      describeRoute({
        operationId: "latex.annotations",
        summary: "Read annotations bound to this immutable PDF",
        responses: { ...response(LatexSchema.Annotations), ...failure },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      async (c) => c.json(await Latex.annotations(c.req.valid("param").id)),
    )
    .put(
      "/build/:id/annotations",
      describeRoute({
        operationId: "latex.annotate",
        summary: "Save build annotations without overwriting concurrent edits",
        responses: { ...response(LatexSchema.Annotations), ...failure },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      validator("json", z.object({ data: PdfAnnotations.File, revision: z.string() })),
      async (c) => c.json(await Latex.annotate(c.req.valid("param").id, c.req.valid("json"))),
    )
    .post(
      "/build/:id/annotations/export",
      describeRoute({
        operationId: "latex.exportAnnotations",
        summary: "Export this PDF with its build-specific annotations",
        responses: {
          200: {
            description: "Annotated PDF",
            content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
          },
          ...failure,
        },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      async (c) => {
        const bytes = await Latex.exportAnnotations(c.req.valid("param").id)
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "application/pdf",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        })
      },
    )
    .post(
      "/build/:id/lease",
      describeRoute({
        operationId: "latex.lease",
        summary: "Protect a viewed PDF for 90 seconds; renew while viewing",
        responses: { ...response(LatexSchema.Lease), ...failure },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      validator("json", z.object({ token: z.string().uuid().optional() })),
      async (c) => c.json(await Latex.lease(c.req.valid("param").id, c.req.valid("json").token)),
    )
    .delete(
      "/build/:id/lease/:token",
      describeRoute({
        operationId: "latex.release",
        summary: "Release this viewer's temporary PDF protection",
        responses: { ...response(z.boolean()), ...failure },
      }),
      validator("param", z.object({ id: z.string().uuid(), token: z.string().uuid() })),
      async (c) => c.json(await Latex.release(c.req.valid("param").id, c.req.valid("param").token)),
    )
    .post(
      "/build/:id/reference",
      describeRoute({
        operationId: "latex.reference",
        summary: "Retain the immutable PDF used by a question",
        responses: { ...response(z.boolean()), ...failure },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      validator("json", z.object({ reference: z.string().min(1).max(256) })),
      async (c) => c.json(await Latex.reference(c.req.valid("param").id, c.req.valid("json").reference)),
    )
    .get(
      "/build/:id",
      describeRoute({
        operationId: "latex.get",
        summary: "Read LaTeX build progress and diagnostics",
        responses: { ...response(LatexSchema.Build), ...failure },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await Latex.get(c.req.valid("param").id)),
    )
    .post(
      "/build/:id/sync/forward",
      describeRoute({
        operationId: "latex.forward",
        summary: "Locate a source line in this immutable PDF build",
        responses: { ...response(LatexSchema.Destination), ...failure },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      validator("json", LatexSchema.Forward),
      async (c) => c.json(await Latex.forward(c.req.valid("param").id, c.req.valid("json"))),
    )
    .post(
      "/build/:id/sync/inverse",
      describeRoute({
        operationId: "latex.inverse",
        summary: "Locate a PDF user-space point in its unchanged source project",
        responses: { ...response(LatexSchema.Source), ...failure },
      }),
      validator("param", z.object({ id: z.string().uuid() })),
      validator("json", LatexSchema.Inverse),
      async (c) => c.json(await Latex.inverse(c.req.valid("param").id, c.req.valid("json"))),
    )
    .post(
      "/build/:id/cancel",
      describeRoute({
        operationId: "latex.cancel",
        summary: "Cancel a LaTeX build and stop its process tree",
        responses: { ...response(LatexSchema.Build), ...failure },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await Latex.cancel(c.req.valid("param").id)),
    )
    .get(
      "/build/:id/pdf",
      describeRoute({
        operationId: "latex.pdf",
        summary: "Read an immutable successful LaTeX PDF",
        responses: {
          200: {
            description: "PDF bytes",
            content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
          },
          ...failure,
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const result = await Latex.pdf(c.req.valid("param").id)
        return new Response(new Uint8Array(result.bytes), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(result.bytes.length),
            "Cache-Control": "private, no-cache",
            ETag: `"${result.hash}"`,
            "X-Content-Type-Options": "nosniff",
            "Accept-Ranges": "none",
          },
        })
      },
    )
    .get(
      "/realtime/status",
      describeRoute({
        operationId: "latex.realtimeStatus",
        summary: "Inspect the realtime TeX engine",
        responses: { ...response(LatexSchema.RealtimeStatus), ...failure },
      }),
      async (c) => c.json(await Latex.realtimeStatus()),
    )
    .post(
      "/realtime/setup",
      describeRoute({
        operationId: "latex.realtimeSetupStart",
        summary: "Download and install the verified rtex release on this server",
        responses: { ...response(LatexSchema.Setup), ...failure },
      }),
      async (c) => c.json(await Latex.realtimeSetupStart()),
    )
    .post(
      "/realtime/setup/cancel",
      describeRoute({
        operationId: "latex.realtimeSetupCancel",
        summary: "Cancel the current rtex installation",
        responses: { ...response(LatexSchema.Setup), ...failure },
      }),
      async (c) => c.json(await Latex.realtimeSetupCancel()),
    )
    .post(
      "/realtime/open",
      describeRoute({
        operationId: "latex.realtimeOpen",
        summary: "Open a realtime LuaLaTeX session for a project",
        responses: { ...response(LatexSchema.RealtimeSession), ...failure },
      }),
      validator("json", LatexSchema.RealtimeOpen),
      async (c) => c.json(await Latex.realtimeOpen(c.req.valid("json"))),
    )
    .post(
      "/realtime/document",
      describeRoute({
        operationId: "latex.realtimeDocument",
        summary: "Replace a file in a realtime session",
        responses: { ...response(z.object({ ok: z.literal(true) })), ...failure },
      }),
      validator("json", LatexSchema.RealtimeDocument),
      async (c) => {
        Latex.realtimeDocument(c.req.valid("json"))
        return c.json({ ok: true as const })
      },
    )
    .post(
      "/realtime/edit",
      describeRoute({
        operationId: "latex.realtimeEdit",
        summary: "Apply a byte-range edit to a realtime session",
        responses: { ...response(z.object({ ok: z.literal(true) })), ...failure },
      }),
      validator("json", LatexSchema.RealtimeEdit),
      async (c) => {
        Latex.realtimeEdit(c.req.valid("json"))
        return c.json({ ok: true as const })
      },
    )
    .post(
      "/realtime/command",
      describeRoute({
        operationId: "latex.realtimeCommand",
        summary: "Send a command to a realtime session",
        responses: { ...response(z.object({ ok: z.literal(true) })), ...failure },
      }),
      validator("json", LatexSchema.RealtimeCommand),
      async (c) => {
        Latex.realtimeCommand(c.req.valid("json"))
        return c.json({ ok: true as const })
      },
    )
    .post(
      "/realtime/close",
      describeRoute({
        operationId: "latex.realtimeClose",
        summary: "Close a realtime session and stop its engines",
        responses: { ...response(z.object({ ok: z.literal(true) })), ...failure },
      }),
      validator("json", LatexSchema.RealtimeClose),
      async (c) => {
        await Latex.realtimeClose(c.req.valid("json"))
        return c.json({ ok: true as const })
      },
    )
    .get(
      "/realtime/events",
      describeRoute({
        operationId: "latex.realtimeEvents",
        summary: "Stream realtime TeX events",
        responses: {
          200: { description: "Server-sent events", content: { "text/event-stream": { schema: resolver(z.any()) } } },
          ...failure,
        },
      }),
      validator("query", z.object({ id: z.string().uuid() })),
      async (c) => {
        const session = Latex.realtimeGet(c.req.valid("query").id)
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamSSE(c, async (stream) => {
          const queue = new AsyncQueue<string | null>()
          let done = false
          const stop = () => {
            if (done) return
            done = true
            clearInterval(heartbeat)
            off()
            queue.push(null)
          }
          for (const event of session.events) queue.push(JSON.stringify(event))
          const off = session.subscribe((event) => queue.push(JSON.stringify(event)))
          const heartbeat = setInterval(() => queue.push(JSON.stringify({ event: "Ping" })), 15_000)
          stream.onAbort(stop)
          try {
            for await (const data of queue) {
              if (data === null) return
              await stream.writeSSE({ data })
            }
          } finally {
            stop()
          }
        })
      },
    )
    .get(
      "/realtime/pdf",
      describeRoute({
        operationId: "latex.realtimePdf",
        summary: "Read one immutable realtime layout PDF",
        responses: {
          200: {
            description: "PDF bytes",
            content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
          },
          ...failure,
        },
      }),
      validator("query", z.object({ id: z.string().uuid(), version: z.coerce.number().int().nonnegative() })),
      async (c) => {
        const input = c.req.valid("query")
        if (input.version < 1) return c.json({ error: "The realtime layout PDF is unavailable." }, 404)
        const file = Latex.realtimePdf(input.id, input.version)
        const data = await Bun.file(file)
          .bytes()
          .catch(() => undefined)
        if (!data) return c.json({ error: "The realtime layout PDF is unavailable." }, 404)
        return new Response(new Uint8Array(data), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(data.length),
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
          },
        })
      },
    )
    .get(
      "/realtime/image",
      describeRoute({
        operationId: "latex.realtimeImage",
        summary: "Read an image referenced by a realtime session",
        responses: {
          200: {
            description: "Image bytes",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          ...failure,
        },
      }),
      validator("query", z.object({ id: z.string().uuid(), path: z.string().min(1).max(4096) })),
      async (c) => {
        const input = c.req.valid("query")
        const file = Latex.realtimeImage(input.id, input.path)
        const data = await Bun.file(file)
          .bytes()
          .catch(() => undefined)
        if (!data) return c.json({ error: "The realtime image is unavailable." }, 404)
        const ext = path.extname(file).toLowerCase()
        const type = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/pdf"
        return new Response(new Uint8Array(data), {
          headers: {
            "Content-Type": type,
            "Content-Length": String(data.length),
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
          },
        })
      },
    )
    .get(
      "/realtime/font",
      describeRoute({
        operationId: "latex.realtimeFont",
        summary: "Read a font referenced by a realtime display list",
        responses: {
          200: {
            description: "Font bytes",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          ...failure,
        },
      }),
      validator(
        "query",
        z.object({
          id: z.string().uuid(),
          filename: z.string().max(4096).optional(),
          name: z.string().max(4096).optional(),
        }),
      ),
      async (c) => {
        const input = c.req.valid("query")
        if (!input.filename && !input.name) return c.json({ error: "A font filename is required." }, 400)
        const resource = await Latex.realtimeFont(input.id, input.filename, input.name)
        if (resource.kind === "missing") return c.json({ error: resource.reason }, 404)
        if (resource.kind === "type1")
          return c.json(resource, 200, { "Cache-Control": "private, max-age=3600" })
        const data = await Bun.file(resource.path)
          .bytes()
          .catch(() => undefined)
        if (!data) return c.json({ error: "The font is unavailable." }, 404)
        return new Response(new Uint8Array(data), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(data.length),
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
          },
        })
      },
    ),
)
