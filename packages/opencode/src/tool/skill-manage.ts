import fs from "fs/promises"
import path from "path"
import os from "os"
import z from "zod"
import { Tool } from "./tool"
import { Global } from "../global"
import { Skill } from "../skill"
import { scanSkill, assertAllowed } from "./skill-guard"
import { SkillDirty } from "../session/skill-dirty"
import { snapshot, snapshotBeforeDelete, rollback as versionRollback, listVersions, formatHistory } from "./skill-versions"
import { Log } from "../util/log"

const log = Log.create({ service: "skill.manage" })

const SKILLS_DIR = path.join(Global.Path.data, "skills")

// ── Security ──────────────────────────────────────────────────────────────────

function hasTraversalComponent(p: string): boolean {
  return p.split(/[\\/]/).some((part) => part === ".." || part === ".")
}

function validateWithinDir(base: string, target: string): void {
  const resolved = path.resolve(base, target)
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    throw new Error(`Path "${target}" is outside the skills directory`)
  }
  if (hasTraversalComponent(target)) {
    throw new Error(`Path "${target}" contains traversal components`)
  }
}

// ── Frontmatter ───────────────────────────────────────────────────────────────

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
    const val = line
      .slice(colon + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "")
    if (key) meta[key] = val
  }
  return { meta, body }
}

function buildContent(name: string, description: string, body: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trimStart()}`
}

// ── Fuzzy patch ───────────────────────────────────────────────────────────────

function fuzzyReplace(content: string, oldStr: string, newStr: string): string | null {
  // Strategy 1: exact
  if (content.includes(oldStr)) {
    return content.replace(oldStr, newStr)
  }
  // Strategy 2: line-trimmed match
  const oldLines = oldStr.split("\n").map((l) => l.trimEnd())
  const newLines = newStr.split("\n")
  const contentLines = content.split("\n")
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const window = contentLines.slice(i, i + oldLines.length).map((l) => l.trimEnd())
    if (window.join("\n") === oldLines.join("\n")) {
      const result = [...contentLines.slice(0, i), ...newLines, ...contentLines.slice(i + oldLines.length)]
      return result.join("\n")
    }
  }
  return null
}

// ── Atomic write ──────────────────────────────────────────────────────────────

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

// ── Tool ──────────────────────────────────────────────────────────────────────

const parameters = z.preprocess(
  (raw: any) => {
    if (!raw || typeof raw !== "object") return raw
    const out = { ...raw }
    // Normalize camelCase/alternate variants that some models generate
    if (out.old_str === undefined) out.old_str = out.oldStr ?? out.oldString ?? out.old_string
    if (out.new_str === undefined) out.new_str = out.newStr ?? out.newString ?? out.new_string
    if (out.relative_path === undefined) out.relative_path = out.relativePath ?? out.relativeP
    return out
  },
  z.object({
  action: z
    .enum(["create", "edit", "patch", "delete", "write_file", "remove_file", "history", "rollback"])
    .describe("Action to perform on a skill"),
  name: z.string().describe("Skill name (directory name under the skills folder). Required for all actions."),
  description: z
    .string()
    .optional()
    .describe("One-line skill description for the frontmatter. Required for create and edit."),
  content: z
    .string()
    .optional()
    .describe("Full skill body (markdown, without frontmatter) for create/edit; file content for write_file."),
  old_str: z.string().optional().describe("Exact text to replace (patch action)"),
  new_str: z.string().optional().describe("Replacement text (patch action)"),
  relative_path: z.string().optional().describe("Path relative to the skill directory for write_file/remove_file"),
  version: z.string().optional().describe("Version label to rollback to, e.g. 'v002' or '2' (rollback action)"),
  }),
)

export const SkillManageTool = Tool.define("skill_manage", async () => {
  return {
    description: [
      "Create, edit, patch, delete, or version-manage skills (reusable procedural memories saved as SKILL.md files).",
      "",
      "Actions:",
      "  create       — Create a new skill with name, description, and content.",
      "  edit         — Fully rewrite a skill (new description + new content). Use when the entire approach has changed.",
      "  patch        — Replace a specific section (old_str → new_str). Use for targeted fixes. IMPORTANT: old_str must exactly match the file content — if the skill content is not already in context, read SKILL.md first. Never guess old_str.",
      "  delete       — Delete a skill and its entire directory.",
      "  history      — List all saved versions of a skill.",
      "  rollback     — Restore a skill to a previous version (requires 'version' param, e.g. 'v002').",
      "  write_file   — Write a supporting file inside the skill directory (scripts, configs, templates, etc.).",
      "                 relative_path must NOT be 'SKILL.md' — use edit or patch for that.",
      "  remove_file  — Remove a supporting file from the skill directory.",
      "                 relative_path must NOT be 'SKILL.md' — use delete to remove the entire skill.",
      "",
      "Every successful create/edit/patch/write_file/remove_file automatically saves a version snapshot.",
      "Use 'history' to browse versions and 'rollback' to recover from a bad evolution.",
      "",
      "Skills are stored under ~/.local/share/aether/skills/<name>/SKILL.md",
    ].join("\n"),
    parameters,
    async execute(
      params: z.infer<typeof parameters>,
      ctx,
    ): Promise<{ title: string; output: string; metadata: Record<string, string> }> {
      const { action, name } = params
      const mark = () => {
        if (!ctx?.sessionID) return
        SkillDirty.add(ctx.sessionID, [name])
      }

      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(`Invalid skill name "${name}". Use only letters, digits, hyphens, underscores.`)
      }

      const skillDir = path.join(SKILLS_DIR, name)
      const skillFile = path.join(skillDir, "SKILL.md")

      log.info("skill_manage called", {
        action,
        name,
        has_description: params.description !== undefined,
        has_content: params.content !== undefined,
        has_old_str: params.old_str !== undefined,
        old_str_len: params.old_str?.length,
        has_new_str: params.new_str !== undefined,
        new_str_len: params.new_str?.length,
        relative_path: params.relative_path,
        version: params.version,
      })

      switch (action) {
        case "create": {
          Skill.markBegin(skillFile)
          try {
            if (!params.description?.trim()) throw new Error("description is required for create")
            if (!params.content?.trim()) throw new Error("content is required for create")
            const exists = await fs.access(skillFile).then(
              () => true,
              () => false,
            )
            if (exists) throw new Error(`Skill "${name}" already exists. Use edit or patch to update it.`)
            const fileContent = buildContent(name, params.description.trim(), params.content)
            await atomicWrite(skillFile, fileContent)
            try {
              assertAllowed(await scanSkill(skillDir))
            } catch (err) {
              await fs.rm(skillDir, { recursive: true, force: true })
              throw err
            }
            await Skill.clearSkillsPromptCache()
            Skill.markClear()
            Skill.markDone(skillFile)
            await snapshot(skillDir, "create")
            mark()
            return {
              title: `Created skill: ${name}`,
              output: `Skill "${name}" created at ${skillFile}`,
              metadata: { skillDir },
            }
          } catch (err) {
            Skill.markDrop(skillFile)
            throw err
          }
        }

        case "edit": {
          Skill.markBegin(skillFile)
          try {
            if (!params.description?.trim()) throw new Error("description is required for edit")
            if (!params.content?.trim()) throw new Error("content is required for edit")
            const oldContent = await fs.readFile(skillFile, "utf8").catch(() => null)
            const fileContent = buildContent(name, params.description.trim(), params.content)
            await atomicWrite(skillFile, fileContent)
            try {
              assertAllowed(await scanSkill(skillDir))
            } catch (err) {
              if (oldContent !== null) await atomicWrite(skillFile, oldContent)
              else await fs.rm(skillDir, { recursive: true, force: true })
              throw err
            }
            await Skill.clearSkillsPromptCache()
            Skill.markClear()
            Skill.markDone(skillFile)
            await snapshot(skillDir, "edit")
            mark()
            return {
              title: `Updated skill: ${name}`,
              output: `Skill "${name}" updated at ${skillFile}`,
              metadata: { skillDir },
            }
          } catch (err) {
            Skill.markDrop(skillFile)
            throw err
          }
        }

        case "patch": {
          Skill.markBegin(skillFile)
          try {
            if (params.old_str === undefined) {
              log.error("patch called without old_str", { name, raw_params: JSON.stringify(params) })
              throw new Error("old_str is required for patch")
            }
            if (params.new_str === undefined) {
              log.error("patch called without new_str", { name, raw_params: JSON.stringify(params) })
              throw new Error("new_str is required for patch")
            }
            const raw = await fs.readFile(skillFile, "utf8").catch(() => {
              throw new Error(`Skill "${name}" not found`)
            })
            const patched = fuzzyReplace(raw, params.old_str, params.new_str)
            if (patched === null) {
              throw new Error(
                `Could not find old_str in skill "${name}". ` +
                `Use the content below to construct the correct old_str and retry with skill_manage(action='patch'). ` +
                `Do NOT fall back to the Edit tool — it bypasses versioning and cache invalidation.\n\nCurrent SKILL.md content:\n\n${raw}`,
              )
            }
            await atomicWrite(skillFile, patched)
            try {
              assertAllowed(await scanSkill(skillDir))
            } catch (err) {
              await atomicWrite(skillFile, raw)
              throw err
            }
            await Skill.clearSkillsPromptCache()
            Skill.markClear()
            Skill.markDone(skillFile)
            await snapshot(skillDir, "patch")
            mark()
            return {
              title: `Patched skill: ${name}`,
              output: `Skill "${name}" patched successfully`,
              metadata: { skillDir },
            }
          } catch (err) {
            Skill.markDrop(skillFile)
            throw err
          }
        }

        case "delete": {
          Skill.markBegin(skillFile)
          try {
            const exists = await fs.access(skillDir).then(
              () => true,
              () => false,
            )
            if (!exists) throw new Error(`Skill "${name}" not found`)
            await fs.rm(skillDir, { recursive: true, force: true })
            await Skill.clearSkillsPromptCache()
            Skill.markClear()
            Skill.markDone(skillFile)
            mark()
            return { title: `Deleted skill: ${name}`, output: `Skill "${name}" deleted`, metadata: {} }
          } catch (err) {
            Skill.markDrop(skillFile)
            throw err
          }
        }

        case "write_file": {
          if (!params.relative_path) throw new Error("relative_path is required for write_file")
          if (params.content === undefined) throw new Error("content is required for write_file")
          if (params.relative_path === "SKILL.md") throw new Error("write_file cannot target SKILL.md. Call skill_manage again with action='edit' (full rewrite) or action='patch' (targeted replacement).")
          validateWithinDir(skillDir, params.relative_path)
          const targetPath = path.join(skillDir, params.relative_path)
          const originalFileContent = await fs.readFile(targetPath, "utf8").catch(() => null)
          await atomicWrite(targetPath, params.content)
          try {
            assertAllowed(await scanSkill(skillDir))
          } catch (err) {
            if (originalFileContent !== null) await atomicWrite(targetPath, originalFileContent)
            else await fs.unlink(targetPath).catch(() => {})
            throw err
          }
          await snapshot(skillDir, "write_file")
          return {
            title: `Wrote file in skill: ${name}`,
            output: `File written: ${targetPath}`,
            metadata: { targetPath },
          }
        }

        case "remove_file": {
          if (!params.relative_path) throw new Error("relative_path is required for remove_file")
          if (params.relative_path === "SKILL.md") throw new Error("remove_file cannot target SKILL.md. To delete the entire skill use action='delete'.")
          validateWithinDir(skillDir, params.relative_path)
          const targetPath = path.join(skillDir, params.relative_path)
          await fs.unlink(targetPath).catch(() => {
            throw new Error(`File not found: ${targetPath}`)
          })
          await snapshot(skillDir, "remove_file")
          return { title: `Removed file in skill: ${name}`, output: `File removed: ${targetPath}`, metadata: {} }
        }

        case "history": {
          const versions = await listVersions(skillDir)
          return {
            title: `Version history: ${name}`,
            output: formatHistory(name, versions),
            metadata: { count: String(versions.length) },
          }
        }

        case "rollback": {
          if (!params.version) throw new Error("version is required for rollback, e.g. 'v002' or '2'")
          Skill.markBegin(skillFile)
          try {
            const { restoredFrom } = await versionRollback(skillDir, params.version)
            await Skill.clearSkillsPromptCache()
            Skill.markClear()
            Skill.markDone(skillFile)
            mark()
            return {
              title: `Rolled back skill: ${name}`,
              output: `Skill "${name}" restored from ${restoredFrom}`,
              metadata: { skillDir, restoredFrom },
            }
          } catch (err) {
            Skill.markDrop(skillFile)
            throw err
          }
        }

        default:
          throw new Error(`Unknown action: ${action}`)
      }
    },
  }
})
