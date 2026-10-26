import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Latex, LatexSchema } from "../../latex"
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
    ),
)
