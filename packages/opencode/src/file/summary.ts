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

export namespace FolderSummary {
  /** Generate and write .summary for a single directory */
  export async function generate(dir: string, root: string): Promise<void> {
    log.info("generating summary", { dir })

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])

    const childFiles = entries
      .filter((e) => e.isFile() && e.name !== SUMMARY_FILE)
      .map((e) => e.name)
      .slice(0, 30)

    const childDirs = entries
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name + "/")

    // Read the first found anchor file for additional context
    let anchorContent = ""
    for (const fname of ANCHOR_FILES) {
      const fpath = path.join(dir, fname)
      if (await Filesystem.exists(fpath)) {
        const content = await Filesystem.readText(fpath).catch(() => "")
        anchorContent = `=== ${fname} ===\n${content.slice(0, 1500)}`
        break
      }
    }

    const relativePath = path.relative(root, dir) || "."

    const prompt = [
      "You are summarizing a directory for AI navigation purposes.",
      `Directory: ${relativePath}`,
      `Subdirectories: ${childDirs.join(", ") || "(none)"}`,
      `Files: ${childFiles.join(", ") || "(none)"}`,
      anchorContent ? `\nKey file content:\n${anchorContent}` : "",
      "\nWrite a brief (2-4 sentence) summary: what code is in this directory, its role in the project, and which subdirectories are most relevant for different tasks. Be concise and concrete. Do not use markdown headers or bullet points.",
    ]
      .filter(Boolean)
      .join("\n")

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
      maxOutputTokens: 200,
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
