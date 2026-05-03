import path from "path"

const SKILL_TOOL_HINT = [
  "Use skill_manage instead:",
  '  Targeted replacement : action="patch",      old_str=<text>,       new_str=<replacement>',
  '  Full rewrite         : action="edit",       description=<desc>,   content=<body>',
  '  Supporting file      : action="write_file", relative_path=<file>, content=<content>',
].join("\n")

// Covers .claude/skills, .agents/skills, .opencode/skills, .opencode/skill, .aether/skills
const SKILL_MARKERS = [".claude", ".agents", ".opencode", ".aether"]
const SKILL_SUBDIRS = ["skills", "skill"]

export function isSkillFilePath(target: string): boolean {
  const normalized = path.resolve(target).split(path.sep).join("/")
  for (const marker of SKILL_MARKERS) {
    for (const sub of SKILL_SUBDIRS) {
      if (normalized.includes(`/${marker}/${sub}/`)) return true
    }
  }
  return false
}

export function assertNotSkillFilePath(tool: string, target: string) {
  if (!isSkillFilePath(target)) return
  throw new Error(
    `${tool} cannot modify skill files (${target}).\n\n${SKILL_TOOL_HINT}`,
  )
}
