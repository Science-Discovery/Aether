import { generateText } from "ai"
import * as fs from "fs/promises"
import * as path from "path"
import { Provider } from "../provider/provider"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

const log = Log.create({ service: "folder.summary" })

const SUMMARY_FILE = ".summary"

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "vendor",
  "target",
  "__pycache__",
  ".next",
  "out",
  ".cache",
  "coverage",
])

const ANCHOR_FILES = [
  "README.md",
  "README.txt",
  "package.json",
  "index.ts",
  "index.js",
  "mod.ts",
  "main.ts",
  "main.py",
  "__init__.py",
]

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".db", ".sqlite", ".lock",
])

type FormatType = "top-level" | "subfolder" | "hybrid"

function detectFormat(childDirs: string[], childFiles: string[]): FormatType {
  const hasDirs = childDirs.length > 0
  const hasFiles = childFiles.length > 0
  if (hasDirs && !hasFiles) return "top-level"
  if (!hasDirs && hasFiles) return "subfolder"
  return "hybrid"
}

async function readAnchorSnippet(dir: string, maxChars: number): Promise<string> {
  for (const fname of ANCHOR_FILES) {
    const fpath = path.join(dir, fname)
    if (await Filesystem.exists(fpath)) {
      const content = await Filesystem.readText(fpath).catch(() => "")
      return content.slice(0, maxChars)
    }
  }
  return ""
}

function isBinaryExt(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function buildFormatTemplate(format: FormatType): string {
  if (format === "top-level") {
    return `OUTPUT FORMAT (directory contains only subdirectories):
\`\`\`markdown
# [Icon] [Title]

[One-sentence description]

| Name | Description | When to Dive In |
|------|-------------|-----------------|
| \`subfolder/\` | [Icon] [Category Name] (N files) | [Trigger Condition] |
\`\`\``
  }
  if (format === "subfolder") {
    return `OUTPUT FORMAT (directory contains only files):
\`\`\`markdown
# [Icon] [Category Name]

| File | Topic | Summary | When to Read |
|------|-------|---------|--------------|
| [filename.ext] | [Topic] | [One-sentence summary] | [Trigger Condition] |
\`\`\``
  }
  return `OUTPUT FORMAT (directory contains both subdirectories and files):
\`\`\`markdown
# [Icon] [Title]

[One-sentence description]

## Subdirectories

| Name | Description | When to Dive In |
|------|-------------|-----------------|
| \`subfolder/\` | [Icon] [Category Name] (N files) | [Trigger Condition] |

## Files

| File | Topic | Summary | When to Read |
|------|-------|---------|--------------|
| [filename.ext] | [Topic] | [One-sentence summary] | [Trigger Condition] |
\`\`\``
}

export namespace FolderSummary {
  /** Generate and write .summary for a single directory */
  export async function generate(dir: string, root: string): Promise<void> {
    log.info("generating summary", { dir })

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])

    const childFiles = entries
      .filter((e) => e.isFile() && e.name !== SUMMARY_FILE)
      .map((e) => e.name)
      .slice(0, 20)

    const childDirs = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name + "/")
      .slice(0, 10)

    const format = detectFormat(childDirs, childFiles)
    const relativePath = path.relative(root, dir) || "."

    // Gather subdirectory info
    const subdirSections: string[] = []
    for (const dirName of childDirs) {
      const subdirPath = path.join(dir, dirName.replace(/\/$/, ""))
      const subEntries = await fs.readdir(subdirPath, { withFileTypes: true }).catch(() => [])
      const fileCount = subEntries.filter((e) => e.isFile()).length
      const anchorSnippet = await readAnchorSnippet(subdirPath, 500)
      subdirSections.push(
        `=== SUBDIR: ${dirName} (${fileCount} files) ===\n${anchorSnippet || "(no anchor file)"}`,
      )
    }

    // Gather file content
    const fileSections: string[] = []
    for (const fileName of childFiles) {
      if (isBinaryExt(fileName)) {
        fileSections.push(`=== FILE: ${fileName} ===\n(binary file)`)
        continue
      }
      const fpath = path.join(dir, fileName)
      const content = await Filesystem.readText(fpath).catch(() => "")
      fileSections.push(`=== FILE: ${fileName} ===\n${content.slice(0, 800)}`)
    }

    const prompt = [
      "You are generating a navigation signpost for a project directory in markdown table format.",
      `Directory: ${relativePath}`,
      "",
      buildFormatTemplate(format),
      "",
      "RULES:",
      '- "When to Dive In" / "When to Read": use "When you need to..." format, max 40 characters',
      "- \"Summary\": one sentence, max 60 characters",
      "- Use appropriate emoji icons for categories",
      "- Include one row per entry listed below",
      "- Output ONLY the markdown content, no explanation or code fences",
      "",
      "DIRECTORY CONTENTS:",
      ...subdirSections,
      ...fileSections,
    ].join("\n")

    // Try the default model first; if not found, fall back to first available non-opencode model.
    // The bundled "opencode" provider may return empty text outside a session context.
    let model: Awaited<ReturnType<typeof Provider.getModel>>
    try {
      const defaultModel = await Provider.defaultModel()
      model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
      if (model.providerID === "opencode") throw new Error("skip bundled provider")
    } catch {
      const providers = await Provider.list()
      const userModels = Object.values(providers)
        .filter((p) => p.id !== "opencode")
        .flatMap((p) => Object.values(p.models))
      const allModels = Object.values(providers).flatMap((p) => Object.values(p.models))
      const candidates = userModels.length > 0 ? userModels : allModels
      const sorted = Provider.sort(candidates)
      if (sorted.length === 0) throw new Error("No available models found")
      model = sorted[0]
    }
    const language = await Provider.getLanguage(model)

    const result = await generateText({
      model: language,
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: 1500,
      temperature: 0.2,
    })

    const summary = result.text.trim()
    await Filesystem.write(path.join(dir, SUMMARY_FILE), summary)
    log.info("summary written", { dir, length: summary.length })
  }

  /** Recursively generate summaries for dir and all subdirs */
  export async function generateAll(
    root: string,
    maxDepth: number,
    force: boolean,
  ): Promise<string[]> {
    const results: string[] = []
    await traverse(root, root, 0, maxDepth, force, results)
    return results
  }

  async function traverse(
    dir: string,
    root: string,
    depth: number,
    maxDepth: number,
    force: boolean,
    results: string[],
  ): Promise<void> {
    if (depth > maxDepth) return

    const summaryPath = path.join(dir, SUMMARY_FILE)

    if (force || !(await Filesystem.exists(summaryPath))) {
      try {
        await generate(dir, root)
        results.push(summaryPath)
      } catch (err) {
        log.error("failed to generate summary", { dir, error: err })
      }
    }

    // Recurse into subdirectories
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
      await traverse(path.join(dir, entry.name), root, depth + 1, maxDepth, force, results)
    }
  }
}
