import z from "zod"
import { PdfAnnotations } from "../pdf-annotations"

export namespace LatexSchema {
  export const Config = z.object({
    tectonic: z.object({ path: z.string().trim().optional() }).optional(),
    latexmk: z.object({ path: z.string().trim().optional() }).optional(),
  })
  export const Driver = z.enum(["auto", "tectonic", "latexmk"])
  export const Program = z.enum(["auto", "pdflatex", "xelatex"])
  export const Setup = z
    .object({
      state: z.enum(["idle", "downloading", "verifying", "extracting", "checking", "ready", "failed", "cancelled"]),
      supported: z.boolean(),
      version: z.string(),
      downloaded: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().optional(),
      path: z.string().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "LatexSetup" })
  export type Setup = z.infer<typeof Setup>
  export const Binding = z
    .object({
      root: z.string(),
      main: z.string(),
      driver: Driver,
      program: Program,
      revision: z.string(),
      updatedAt: z.number(),
    })
    .meta({ ref: "LatexBinding" })
  export type Binding = z.infer<typeof Binding>
  export const Diagnostic = z
    .object({
      severity: z.enum(["error", "warning", "info"]),
      message: z.string(),
      path: z.string().optional(),
      line: z.number().int().positive().optional(),
    })
    .meta({ ref: "LatexDiagnostic" })
  export type Diagnostic = z.infer<typeof Diagnostic>
  export const Build = z
    .object({
      id: z.string(),
      root: z.string(),
      main: z.string(),
      bindingRevision: z.string(),
      sourceRevision: z.string().optional(),
      state: z.enum(["preparing", "running", "succeeded", "failed", "cancelled"]),
      driver: z.enum(["tectonic", "latexmk"]).optional(),
      program: z.enum(["pdflatex", "xelatex"]).optional(),
      createdAt: z.number(),
      startedAt: z.number().optional(),
      completedAt: z.number().optional(),
      diagnostics: Diagnostic.array(),
      log: z.string(),
      truncated: z.boolean(),
      pdf: z.boolean(),
      sync: z.object({ state: z.enum(["ready", "unavailable"]), reason: z.string().optional() }).optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "LatexBuild" })
  export type Build = z.infer<typeof Build>
  export const Version = z
    .object({
      build: Build,
      pdfHash: z.string(),
      annotationCount: z.number().int().nonnegative(),
      referenced: z.boolean(),
      viewing: z.boolean(),
    })
    .meta({ ref: "LatexVersion" })
  export const Annotations = z
    .object({ status: z.literal("ready"), data: PdfAnnotations.File, revision: z.string() })
    .meta({ ref: "LatexAnnotations" })
  export const Lease = z.object({ token: z.string().uuid(), expiresAt: z.number() }).meta({ ref: "LatexLease" })
  export const Cleanup = z
    .object({ removed: z.string().array(), versions: Version.array() })
    .meta({ ref: "LatexCleanup" })
  export const Freshness = z
    .object({
      state: z.enum(["fresh", "stale", "unknown"]),
      checkedAt: z.number().optional(),
      sourceRevision: z.string().optional(),
    })
    .meta({ ref: "LatexFreshness" })
  export type Freshness = z.infer<typeof Freshness>
  export const Project = z
    .object({
      root: z.string(),
      main: z.string().optional(),
      binding: Binding.optional(),
      candidates: z.string().array(),
      reason: z.enum(["binding", "magic", "single", "ambiguous", "missing"]),
      issue: z.string().optional(),
      freshness: Freshness,
      latest: Build.optional(),
      lastSuccessful: Build.optional(),
      editors: z.array(z.object({ path: z.string(), checksum: z.string().nullable() })),
    })
    .meta({ ref: "LatexProject" })
  export type Project = z.infer<typeof Project>
  export const Status = z
    .object({
      tools: z.array(
        z.object({
          driver: z.enum(["tectonic", "latexmk"]),
          installed: z.boolean(),
          path: z.string().optional(),
          version: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    })
    .meta({ ref: "LatexStatus" })
  export const Selection = z.object({
    root: z.string(),
    main: z.string(),
    driver: Driver.default("auto"),
    program: Program.default("auto"),
    expectedRevision: z.string().optional(),
  })
  export const Start = z.object({
    root: z.string(),
    bindingRevision: z.string(),
    sourceRevision: z.string().optional(),
    allowDownloads: z.boolean().default(false),
  })
  export const Refresh = z.object({
    root: z.string(),
    editors: z.string().array().max(500).default([]),
  })
  export const Forward = z.object({
    path: z.string().min(1).max(4096),
    line: z.number().int().positive().max(10_000_000),
    column: z.number().int().positive().max(10_000_000).optional(),
  })
  export const Inverse = z.object({
    page: z.number().int().positive().max(10_000),
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
  })
  export const Destination = z
    .object({
      page: z.number().int().positive(),
      rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
    .meta({ ref: "LatexDestination" })
  export const Source = z
    .object({
      path: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive().optional(),
    })
    .meta({ ref: "LatexSource" })
  export class Error extends globalThis.Error {
    constructor(
      readonly code: 400 | 404 | 409 | 413 | 503,
      message: string,
    ) {
      super(message)
      this.name = "LatexError"
    }
  }
}
