import { ConfigMarkdown } from "../config/markdown"
import { Skill } from "../skill"
import { SkillDirty } from "./skill-dirty"
import { Log } from "../util/log"

type Entry = {
  name: string
  content: string
}

type Patch = {
  names: string[]
  text: string
}

export namespace SkillRefresh {
  export async function load(name: string) {
    const item = await Skill.get(name).catch(() => undefined)
    if (!item) return
    const content = await ConfigMarkdown.parse(item.location)
      .then((md) => md.content)
      .catch(() => item.content)
    return {
      name,
      content,
    } satisfies Entry
  }

  export async function patch(sessionID: string, read: (name: string) => Promise<Entry | undefined> = load) {
    const names = SkillDirty.take(sessionID)
    if (names.length === 0) return
    const list: string[] = []
    for (const name of names) {
      const item = await read(name)
      if (!item) {
        list.push(
          `<skill_content name="${name}">\n# Skill: ${name}\n\nSkill was removed or is unavailable.\n</skill_content>`,
        )
        continue
      }
      list.push(
        `<skill_content name="${item.name}">\n# Skill: ${item.name}\n\n${item.content.trim()}\n</skill_content>`,
      )
    }
    if (list.length === 0) return
    Log.activity(`[skill dirty] reload session=${sessionID} skills=${names.join(", ")}`)
    Log.activity(`[skill dirty] patch built session=${sessionID} skills=${names.join(", ")} blocks=${list.length}`)
    return {
      names,
      text: [
        "Skill content updated. Replace any previously loaded versions with the latest versions below.",
        "",
        ...list,
      ].join("\n"),
    } satisfies Patch
  }
}
