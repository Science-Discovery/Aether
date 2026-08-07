import fs from "fs/promises"
import path from "path"
import z from "zod"
import { AttachmentExtraction } from "@/attachment-extraction"
import { Config } from "@/config/config"
import { ManagedMinerU } from "@/mineru/managed"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Tool } from "./tool"

const Range = z
  .object({
    start_page: z.number().int().positive(),
    end_page: z.number().int().positive(),
  })
  .refine((value) => value.start_page <= value.end_page, "start_page must not exceed end_page")

async function setup() {
  const cfg = (await Config.get()).experimental?.attachment_text_extraction
  const mode = cfg?.mineru?.mode ?? "external"
  if (mode === "external") {
    return { configured: !!cfg?.mineru?.base_url, mode, url: cfg?.mineru?.base_url }
  }
  const state = await ManagedMinerU.status()
  return {
    configured: state.install === "ready",
    mode,
    url: state.base_url ?? cfg?.mineru?.base_url,
    state,
  }
}

async function local() {
  const cfg = await setup()
  if (cfg.mode !== "managed") {
    throw new Error(
      "AI MinerU tools cannot send files to a custom service. Use an Aether AI configured local service instead.",
    )
  }
  if (!cfg.configured || cfg.state?.install !== "ready") {
    throw new Error("MinerU has not been configured. Configure it in Attachment text extraction settings first.")
  }
  if (!cfg.url) throw new Error("The configured MinerU service has no local address")
  const url = new URL(cfg.url)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("AI MinerU tools require an Aether-managed service bound to 127.0.0.1")
  }
  return { ...cfg, url: url.toString().replace(/\/+$/, "") }
}

async function start() {
  await local()
  const state = await ManagedMinerU.start()
  if (!state.base_url || state.run !== "running") throw new Error("MinerU could not be started")
  return { mode: "managed" as const, url: state.base_url, state }
}

async function source(input: string) {
  const file = path.isAbsolute(input) ? input : path.resolve(Instance.directory, input)
  const real = await fs.realpath(file).catch(() => "")
  if (!real || !Instance.containsPath(real)) {
    throw new Error("MinerU can only convert files inside the current workspace")
  }
  const stat = await fs.stat(real).catch(() => undefined)
  if (!stat?.isFile()) throw new Error("The MinerU input must be an existing file")
  if (stat.size > 512 * 1024 ** 2) throw new Error("MinerU tool input is limited to 512 MiB")
  const mime = Filesystem.mimeType(real)
  if (mime !== "application/pdf" && !mime.startsWith("image/")) {
    throw new Error("MinerU supports only PDF and image files")
  }
  return { file: real, mime }
}

async function target(input: string | undefined, source: string) {
  if (input) {
    const file = path.isAbsolute(input) ? path.resolve(input) : path.resolve(Instance.directory, input)
    if (path.extname(file).toLowerCase() !== ".md") throw new Error("MinerU output must use the .md extension")
    const parent = await fs.realpath(path.dirname(file)).catch(() => "")
    if (!parent || !Instance.containsPath(parent)) {
      throw new Error("MinerU can only save Markdown inside the current workspace")
    }
    if (await Filesystem.exists(file)) throw new Error("The requested Markdown output already exists")
    return file
  }
  const parsed = path.parse(source)
  const base = path.join(parsed.dir, `${parsed.name}.mineru`)
  const file = `${base}.md`
  if (!(await Filesystem.exists(file))) return file
  for (let index = 2; index <= 999; index++) {
    const next = `${base}-${index}.md`
    if (!(await Filesystem.exists(next))) return next
  }
  throw new Error("Could not choose an unused Markdown output name")
}

export const MineruStatusTool = Tool.define("mineru_status", {
  description:
    "Check whether Aether has a configured MinerU service and report its setup and runtime status. Call this before building a workflow that depends on MinerU.",
  parameters: z.object({}),
  async execute() {
    const cfg = await setup()
    const external = cfg.mode === "external"
    const value = {
      configured: cfg.configured,
      mode: cfg.mode,
      install: cfg.state?.install ?? (cfg.configured ? "external" : "unconfigured"),
      runtime: cfg.state?.run ?? "unknown",
      healthy: external ? undefined : cfg.state?.run === "running",
      base_url: cfg.url,
      version: cfg.state?.version,
      ai_conversion_available: cfg.mode === "managed" && cfg.configured,
      note: external
        ? "Custom services are not contacted by AI MinerU tools to avoid sending workspace files to an unconfirmed destination."
        : undefined,
    }
    return {
      title: cfg.configured ? "MinerU is configured" : "MinerU is not configured",
      metadata: value,
      output: JSON.stringify(value, null, 2),
    }
  },
})

export const MineruStartTool = Tool.define("mineru_start", {
  description:
    "Start the Aether AI configured local MinerU service and verify its health. MinerU must already be configured, and custom service addresses are never accepted.",
  parameters: z.object({}),
  async execute() {
    const cfg = await start()
    const value = { configured: true, mode: cfg.mode, healthy: true, base_url: cfg.url }
    return { title: "MinerU is running", metadata: value, output: JSON.stringify(value, null, 2) }
  },
})

export const MineruConvertTool = Tool.define("mineru_convert", {
  description:
    "Convert a PDF or image inside the current workspace to Markdown using the Aether AI configured local MinerU service. MinerU must already be configured. Never overwrites an existing output file.",
  parameters: z.object({
    input: z.string().describe("Workspace-relative or absolute path to a PDF or image inside the current workspace"),
    output: z
      .string()
      .optional()
      .describe("Optional workspace-relative or absolute .md output path. Omit to create a unique file beside the input"),
    pages: Range.optional().describe("Optional inclusive 1-based PDF page range"),
  }),
  async execute(args, ctx) {
    await local()
    const input = await source(args.input)
    if (args.pages && input.mime !== "application/pdf") throw new Error("Page ranges are available only for PDF files")
    const output = await target(args.output, input.file)
    const rel = path.relative(Instance.worktree, input.file).replaceAll("\\", "/")
    const out = path.relative(Instance.worktree, output).replaceAll("\\", "/")
    await ctx.ask({ permission: "read", patterns: [rel], always: [rel], metadata: { filepath: input.file } })
    await ctx.ask({ permission: "edit", patterns: [out], always: [out], metadata: { filepath: output } })
    ctx.metadata({ title: "Starting MinerU", metadata: { input: input.file, output } })
    const cfg = await start()
    ctx.metadata({ title: "Converting with MinerU", metadata: { input: input.file, output } })
    const text = await AttachmentExtraction.convert({
      root: cfg.url,
      file: { id: ctx.callID ?? "mineru", mime: input.mime, filename: path.basename(input.file), url: "data:," },
      blob: Bun.file(input.file),
      range: args.pages ? { startPage: args.pages.start_page, endPage: args.pages.end_page } : undefined,
      signal: ctx.abort,
    })
    const file = await fs.open(output, "wx")
    await file.writeFile(text).finally(() => file.close())
    return {
      title: `Converted ${path.basename(input.file)}`,
      metadata: { input: input.file, output, characters: text.length, mode: cfg.mode, base_url: cfg.url },
      output: `MinerU converted the file to Markdown.\n\nInput: ${input.file}\nOutput: ${output}\nCharacters: ${text.length}`,
    }
  },
})

export const MineruToolTest = { setup, local, source, target }
