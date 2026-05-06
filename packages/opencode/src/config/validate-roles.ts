import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Config } from "./config"
import { Log } from "../util/log"

const log = Log.create({ service: "validate-roles" })

export interface ValidationWarning {
  type: "missing_skill_ref" | "empty_prompt"
  agent?: string
  detail: string
}

export async function validate(): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []
  const cfg = await Config.get()
  const agents = await Agent.list()
  const allSkills = await Skill.all()
  const skillNames = new Set(allSkills.map((s) => s.name))

  for (const agent of agents) {
    if (agent.skillRefs?.length) {
      for (const ref of agent.skillRefs) {
        if (!skillNames.has(ref)) {
          warnings.push({
            type: "missing_skill_ref",
            agent: agent.name,
            detail: `skill "${ref}" not found in skill library`,
          })
        }
      }
    }

    if (!agent.prompt && !agent.native) {
      warnings.push({
        type: "empty_prompt",
        agent: agent.name,
        detail: `agent "${agent.name}" has no system prompt defined`,
      })
    }
  }

  for (const w of warnings) {
    log.warn("validation warning", w)
  }

  return warnings
}
