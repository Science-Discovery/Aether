import fs from "fs/promises"
import path from "path"
import z from "zod"
import { ShadowWriter } from "./shadow-writer"
import { Guard } from "./guard"
import { Versions } from "./versions"
import { Publisher } from "./publisher"
import { Tool } from "../tool/tool"

// ── Atomic write ─────────────────────────────────────────────────────────────

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = filePath + ".tmp." + Date.now()
  try {
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, filePath)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

// ── Frontmatter helpers ───────────────────────────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  if (!content.startsWith("---")) return { meta: {}, body: content }
  const end = content.indexOf("\n---", 3)
  if (end === -1) return { meta: {}, body: content }
  const yaml = content.slice(3, end).trim()
  const body = content.slice(end + 4).trimStart()
  const meta: Record<string, string> = {}
  for (const line of yaml.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "")
    if (key) meta[key] = val
  }
  return { meta, body }
}

function buildContent(name: string, description: string, body: string, category?: string): string {
  const categoryLine = category?.trim() ? `\ncategory: ${JSON.stringify(category.trim())}` : ""
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}${categoryLine}\n---\n\n${body.trimStart()}`
}

// ── Fuzzy patch ───────────────────────────────────────────────────────────────

function fuzzyReplace(content: string, oldStr: string, newStr: string): string | null {
  // Strategy 1: exact match
  if (content.includes(oldStr)) return content.replace(oldStr, newStr)
  // Strategy 2: line-trimmed match
  const oldLines = oldStr.split("\n").map((l) => l.trimEnd())
  const newLines = newStr.split("\n")
  const contentLines = content.split("\n")
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const window = contentLines.slice(i, i + oldLines.length).map((l) => l.trimEnd())
    if (window.join("\n") === oldLines.join("\n")) {
      return [...contentLines.slice(0, i), ...newLines, ...contentLines.slice(i + oldLines.length)].join("\n")
    }
  }
  return null
}

// ── Schema ────────────────────────────────────────────────────────────────────

/** Input schema exposed to the review agent as the `skill_manage` tool. */
export const SkillManageInput = z.preprocess(
  (raw: any) => {
    if (!raw || typeof raw !== "object") return raw
    const out = { ...raw }
    if (out.old_str === undefined) out.old_str = out.oldStr ?? out.oldString ?? out.old_string
    if (out.new_str === undefined) out.new_str = out.newStr ?? out.newString ?? out.new_string
    return out
  },
  z.object({
    action: z.enum(["create", "edit", "patch", "write_file", "delete", "history", "rollback"]).describe(
      "Action to perform on a skill",
    ),
    name: z.string()
      .regex(/^[a-zA-Z0-9_-]+$/, "Skill name must only contain letters, numbers, hyphens, or underscores")
      .describe("Skill name (directory name under the skills folder). Required for all actions."),
    description: z
      .string()
      .optional()
      .describe("One-line skill description for the frontmatter. Required for create and edit."),
    category: z
      .string()
      .optional()
      .describe(
        "Short category label for grouping skills (e.g. 'Git', 'Testing', 'Refactoring'). Required for create and edit — always infer one from the skill content if not obvious.",
      ),
    content: z.string().optional().describe("Full skill body (markdown, without frontmatter) for create/edit; file content for write_file."),
    old_str: z.string().optional().describe("Exact text to replace (patch action). Read SKILL.md first if content is not already in context — never guess."),
    new_str: z.string().optional().describe("Replacement text (patch action)"),
    /** For write_file: name of the auxiliary file to write */
    filename: z.string().optional().describe("Auxiliary file name within the skill directory (for write_file)"),
    /** For write_file: content to write into the auxiliary file */
    file_content: z.string().optional().describe("Content to write into the auxiliary file (for write_file)"),
    /** For rollback: version identifier such as 'v002' */
    version: z.string().optional().describe("Version label to rollback to, e.g. 'v002' or '2' (rollback action)"),
    /** Project ID used when writing AI-created skills to the skill-sessions bucket */
    sessionProjectId: z.string().optional().describe("Project ID for AI-created skill routing"),
    /** Original skill location — enables copy-on-write instead of direct write */
    skillLocation: z.string().optional().describe("Original SKILL.md path for copy-on-write"),
  }),
)
export type SkillManageInput = z.infer<typeof SkillManageInput>

export interface SkillManageResult {
  ok: boolean
  message: string
  skillDir?: string
}

const skillLocks = new Map<string, Promise<void>>()

async function withSkillLock<T>(skillDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = skillLocks.get(skillDir) ?? Promise.resolve()
  let resolve!: () => void
  const current = new Promise<void>(r => { resolve = r })
  skillLocks.set(skillDir, current)
  await prev
  try {
    return await fn()
  } finally {
    resolve()
    if (skillLocks.get(skillDir) === current) skillLocks.delete(skillDir)
  }
}

export namespace SkillManageTool {
  export async function execute(input: SkillManageInput): Promise<SkillManageResult> {
    const skillDir = ShadowWriter.resolveSkillDir(input.name, input.skillLocation, input.sessionProjectId)
    return withSkillLock(skillDir, async () => {
      try {
        switch (input.action) {
          case "create":
            return await handleCreate(input)
          case "edit":
            return await handleEdit(input)
          case "patch":
            return await handlePatch(input)
          case "write_file":
            return await handleWriteFile(input)
          case "delete":
            return await handleDelete(input)
          case "history":
            return await handleHistory(input)
          case "rollback":
            return await handleRollback(input)
        }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    })
  }

  async function resolveAndPrepare(input: SkillManageInput): Promise<string> {
    const skillDir = ShadowWriter.resolveSkillDir(input.name, input.skillLocation, input.sessionProjectId)

    // If the skill has an original location and shadow doesn't exist yet, copy it over
    if (input.skillLocation) {
      if (!ShadowWriter.validateSkillLocation(input.skillLocation)) {
        throw new Error(
          `Unsafe skillLocation rejected: "${input.skillLocation}". ` +
          `Must point to a file inside a <config-marker>/skills/ directory (e.g. .claude/skills/foo/SKILL.md).`,
        )
      }
      const originalDir = path.dirname(input.skillLocation)
      const shadowExists = await fs.access(skillDir).then(() => true).catch(() => false)
      if (!shadowExists) {
        await ShadowWriter.copyToShadowIfNeeded(originalDir, skillDir)
        await Versions.create(skillDir, "original")
      }
    } else {
      await fs.mkdir(skillDir, { recursive: true })
    }

    return skillDir
  }

  async function guardAndPublish(skillDir: string, action: string): Promise<SkillManageResult> {
    const result = await Guard.scan(skillDir, "agent-created")
    if (result.worstSeverity === "dangerous") {
      // Roll back by removing the directory if it was newly created, otherwise
      // revert via the most recent snapshot if available.
      const versions = await Versions.list(skillDir)
      if (versions.length > 0) {
        const previous = versions[versions.length - 1]
        if (previous) {
          await Versions.rollback(skillDir, previous.filename.replace(".bundle.json", ""))
        }
      }

      const issues = result.issues.map((i) => `${path.basename(i.file)}:${i.line} — ${i.description}`).join("; ")
      return {
        ok: false,
        message: `Security scan blocked the write. Issues: ${issues}`,
        skillDir,
      }
    }

    await Versions.create(skillDir, action)
    await Publisher.publishSkillSaved()

    return { ok: true, message: `skill_manage(${action}) succeeded`, skillDir }
  }

  async function handleCreate(input: SkillManageInput): Promise<SkillManageResult> {
    if (!input.description?.trim()) return { ok: false, message: "description is required for action=create" }
    if (!input.content?.trim()) return { ok: false, message: "content is required for action=create" }

    const skillDir = await resolveAndPrepare(input)
    const skillMd = path.join(skillDir, "SKILL.md")
    const fileContent = buildContent(input.name, input.description.trim(), input.content, input.category)
    await atomicWrite(skillMd, fileContent)

    return guardAndPublish(skillDir, "create")
  }

  async function handleEdit(input: SkillManageInput): Promise<SkillManageResult> {
    if (!input.description?.trim()) return { ok: false, message: "description is required for action=edit" }
    if (!input.content?.trim()) return { ok: false, message: "content is required for action=edit" }

    const skillDir = await resolveAndPrepare(input)
    const skillMd = path.join(skillDir, "SKILL.md")
    const oldContent = await fs.readFile(skillMd, "utf-8").catch(() => null)
    const existingCategory = oldContent ? parseFrontmatter(oldContent).meta.category : undefined
    const fileContent = buildContent(input.name, input.description.trim(), input.content, input.category ?? existingCategory)
    await atomicWrite(skillMd, fileContent)

    return guardAndPublish(skillDir, "edit")
  }

  async function handlePatch(input: SkillManageInput): Promise<SkillManageResult> {
    if (input.old_str === undefined) return { ok: false, message: "old_str is required for action=patch" }
    if (input.new_str === undefined) return { ok: false, message: "new_str is required for action=patch" }

    const skillDir = await resolveAndPrepare(input)
    const skillMd = path.join(skillDir, "SKILL.md")
    const raw = await fs.readFile(skillMd, "utf-8").catch(() => null)
    if (raw === null) return { ok: false, message: `Skill "${input.name}" not found` }

    const patched = fuzzyReplace(raw, input.old_str, input.new_str)
    if (patched === null) {
      return {
        ok: false,
        message:
          `Could not find old_str in skill "${input.name}". ` +
          `Use the content below to construct the correct old_str and retry.\n\nCurrent SKILL.md:\n\n${raw}`,
      }
    }
    await atomicWrite(skillMd, patched)

    return guardAndPublish(skillDir, "patch")
  }

  async function handleWriteFile(input: SkillManageInput): Promise<SkillManageResult> {
    if (!input.filename) return { ok: false, message: "filename is required for action=write_file" }
    if (input.file_content === undefined) return { ok: false, message: "file_content is required for action=write_file" }
    const skillDir = await resolveAndPrepare(input)
    const target = path.resolve(skillDir, input.filename)
    if (!target.startsWith(skillDir + path.sep)) {
      return { ok: false, message: "filename must be within the skill directory" }
    }
    await atomicWrite(target, input.file_content)

    return guardAndPublish(skillDir, "write_file")
  }

  async function handleDelete(input: SkillManageInput): Promise<SkillManageResult> {
    const skillDir = ShadowWriter.resolveSkillDir(input.name, input.skillLocation, input.sessionProjectId)
    const exists = await fs.access(skillDir).then(() => true).catch(() => false)
    if (!exists) return { ok: false, message: `Skill directory not found: ${skillDir}` }

    await fs.rm(skillDir, { recursive: true, force: true })
    await Publisher.publishSkillSaved()

    return { ok: true, message: `Skill "${input.name}" deleted`, skillDir }
  }

  async function handleHistory(input: SkillManageInput): Promise<SkillManageResult> {
    const skillDir = ShadowWriter.resolveSkillDir(input.name, input.skillLocation, input.sessionProjectId)
    const entries = await Versions.list(skillDir)
    if (entries.length === 0) return { ok: true, message: "No version history found", skillDir }

    const lines = entries.map(
      (e) => `  ${e.filename.replace(".bundle.json", "")}  (${e.action}, ${e.timestamp})`,
    )
    return { ok: true, message: `Version history:\n${lines.join("\n")}`, skillDir }
  }

  async function handleRollback(input: SkillManageInput): Promise<SkillManageResult> {
    if (!input.version) return { ok: false, message: "version is required for action=rollback" }

    const skillDir = ShadowWriter.resolveSkillDir(input.name, input.skillLocation, input.sessionProjectId)
    await Versions.rollback(skillDir, input.version)
    await Publisher.publishSkillSaved()

    return { ok: true, message: `Rolled back "${input.name}" to ${input.version}`, skillDir }
  }
}

const SKILL_MANAGE_DESCRIPTION = [
  "The sole tool for modifying skill files. Use instead of edit/write for any file under a skills/ directory.",
  "Create, edit, patch, delete, or version-manage skills (reusable procedural memories saved as SKILL.md files).",
  "",
  "Actions:",
  "  create     — Create a new skill with name, description, category, and content.",
  "  edit       — Fully rewrite a skill (new description + category + new content). Use when the entire approach has changed.",
  "  patch      — Replace a specific section (old_str → new_str). Equivalent to the edit tool's oldString→newString, but for skill files. IMPORTANT: old_str must exactly match the file content — if the skill content is not already in context, read SKILL.md first. Never guess old_str.",
  "  delete     — Delete a skill and its entire directory.",
  "  history    — List all saved versions of a skill.",
  "  rollback   — Restore a skill to a previous version (requires 'version' param, e.g. 'v002' or '2').",
  "  write_file — Write a supporting file inside the skill directory (scripts, configs, templates, etc.).",
  "",
  "Every successful create/edit/patch/write_file automatically saves a version snapshot.",
  "Use 'history' to browse versions and 'rollback' to recover from a bad evolution.",
  "",
  "Modifications are written to a shadow .aether/skills/<name>/ directory.",
  "Original skills (in .claude/, .agents/, .opencode/) are never modified.",
  "On first evolution, the original skill directory is copied into .aether/, then patched there.",
].join("\n")

export const SkillManageToolDef = Tool.define("skill_manage", {
  description: SKILL_MANAGE_DESCRIPTION,
  parameters: SkillManageInput,
  async execute(params) {
    const result = await SkillManageTool.execute(params)
    return {
      title: `skill_manage(${params.action}: ${params.name})`,
      output: result.message,
      metadata: { ok: result.ok, skillDir: result.skillDir },
    }
  },
})

/**
 * Returns a version of SkillManageToolDef with a default sessionProjectId baked in.
 * Used by review sessions so AI-created skills land in the project-level directory
 * without the model needing to know or pass the project ID.
 */
export function createBoundSkillManageTool(
  defaultSessionProjectId: string,
  skillLocationMap?: Record<string, string>,
  skillSessionMap?: Record<string, string>,
): typeof SkillManageToolDef {
  return Tool.define("skill_manage", {
    description: SKILL_MANAGE_DESCRIPTION,
    parameters: SkillManageInput,
    async execute(params) {
      const resolvedLocation = params.skillLocation ?? skillLocationMap?.[params.name]
      const resolvedSessionId =
        params.sessionProjectId ??
        skillSessionMap?.[params.name] ??
        (!resolvedLocation ? defaultSessionProjectId : undefined)
      const result = await SkillManageTool.execute({
        ...params,
        skillLocation: resolvedLocation,
        sessionProjectId: resolvedSessionId,
      })
      return {
        title: `skill_manage(${params.action}: ${params.name})`,
        output: result.message,
        metadata: { ok: result.ok, skillDir: result.skillDir },
      }
    },
  })
}
