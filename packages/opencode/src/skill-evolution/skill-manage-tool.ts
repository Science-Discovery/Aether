import fs from "fs/promises"
import path from "path"
import z from "zod"
import { ShadowWriter } from "./shadow-writer"
import { Guard } from "./guard"
import { Versions } from "./versions"
import { Publisher } from "./publisher"

/** Input schema exposed to the review agent as the `skill_manage` tool. */
export const SkillManageInput = z.object({
  action: z.enum(["create", "edit", "patch", "write_file", "delete", "history", "rollback"]).describe(
    "Operation to perform on the skill",
  ),
  name: z.string().describe("Skill directory name (slug, no spaces)"),
  /** For create / edit: full replacement content of SKILL.md */
  content: z.string().optional().describe("Full content of SKILL.md (for create / edit)"),
  /** For write_file: name of the auxiliary file to write */
  filename: z.string().optional().describe("Auxiliary file name within the skill directory (for write_file)"),
  /** For write_file: content to write into the auxiliary file */
  file_content: z.string().optional().describe("Content to write into the auxiliary file (for write_file)"),
  /** For rollback: version identifier such as 'v002' */
  version: z.string().optional().describe("Version identifier for rollback (e.g. 'v002')"),
  /** Project ID used when writing AI-created skills to the skill-sessions bucket */
  sessionProjectId: z.string().optional().describe("Project ID for AI-created skill routing"),
  /** Original skill location — enables copy-on-write instead of direct write */
  skillLocation: z.string().optional().describe("Original SKILL.md path for copy-on-write"),
})
export type SkillManageInput = z.infer<typeof SkillManageInput>

export interface SkillManageResult {
  ok: boolean
  message: string
  skillDir?: string
}

export namespace SkillManageTool {
  export async function execute(input: SkillManageInput): Promise<SkillManageResult> {
    switch (input.action) {
      case "create":
        return handleCreate(input)
      case "edit":
        return handleEdit(input)
      case "patch":
        return handlePatch(input)
      case "write_file":
        return handleWriteFile(input)
      case "delete":
        return handleDelete(input)
      case "history":
        return handleHistory(input)
      case "rollback":
        return handleRollback(input)
    }
  }

  async function resolveAndPrepare(input: SkillManageInput): Promise<string> {
    const skillDir = ShadowWriter.resolveSkillDir(input.name, input.skillLocation, input.sessionProjectId)

    // If the skill has an original location and shadow doesn't exist yet, copy it over
    if (input.skillLocation) {
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
        const previous = versions[versions.length - 2] // second-to-last
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
    if (!input.content) return { ok: false, message: "content is required for action=create" }

    const skillDir = await resolveAndPrepare(input)
    const skillMd = path.join(skillDir, "SKILL.md")
    await fs.writeFile(skillMd, input.content, "utf-8")

    return guardAndPublish(skillDir, "create")
  }

  async function handleEdit(input: SkillManageInput): Promise<SkillManageResult> {
    if (!input.content) return { ok: false, message: "content is required for action=edit" }

    const skillDir = await resolveAndPrepare(input)
    const skillMd = path.join(skillDir, "SKILL.md")
    await fs.writeFile(skillMd, input.content, "utf-8")

    return guardAndPublish(skillDir, "edit")
  }

  async function handlePatch(input: SkillManageInput): Promise<SkillManageResult> {
    if (!input.content) return { ok: false, message: "content is required for action=patch (provide the new full content)" }

    const skillDir = await resolveAndPrepare(input)
    const skillMd = path.join(skillDir, "SKILL.md")
    await fs.writeFile(skillMd, input.content, "utf-8")

    return guardAndPublish(skillDir, "patch")
  }

  async function handleWriteFile(input: SkillManageInput): Promise<SkillManageResult> {
    if (!input.filename) return { ok: false, message: "filename is required for action=write_file" }
    if (input.file_content === undefined) return { ok: false, message: "file_content is required for action=write_file" }
    if (input.filename.includes("..") || path.isAbsolute(input.filename)) {
      return { ok: false, message: "filename must be a relative path within the skill directory" }
    }

    const skillDir = await resolveAndPrepare(input)
    const target = path.join(skillDir, input.filename)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, input.file_content, "utf-8")

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
