import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { SKILLS_GUIDANCE } from "./skill-evolution"

export namespace SystemPrompt {
  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) return [PROMPT_CODEX]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_DEFAULT]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  export async function skills(agent: Agent.Info, availableTools?: Set<string>, availableToolsets?: Set<string>) {
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    const all = await Skill.available(agent)
    const list = availableTools !== undefined
      ? all.filter((skill) => Skill.matchesConditions(skill, availableTools, availableToolsets ?? new Set()))
      : all

    for (const skill of list) {
      console.log(`[skill source] ${skill.name} → ${skill.location}`)
    }

    return [
      "## Skills (mandatory)",
      "Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST follow its instructions.",
      "Err on the side of using a skill — it is always better to have context you don't need than to miss critical steps, pitfalls, or established workflows.",
      "Skills encode the user's preferred approach, conventions, and quality standards — follow them even for tasks you already know how to do.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(list, { verbose: true }),
      "",
      "If a skill has issues, fix it with skill_manage(action='patch').",
      "After difficult/iterative tasks, offer to save as a skill.",
      "If a skill you loaded was missing steps, had wrong commands, or needed pitfalls you discovered, update it before finishing.",
      "",
      SKILLS_GUIDANCE,
    ].join("\n")
  }
}
