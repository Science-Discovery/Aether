import { ConfigMarkdown } from "../config/markdown"
import { Skill } from "../skill"
import { SkillDirty } from "./skill-dirty"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"

type Entry = { name: string; content: string } | undefined

export namespace SkillRefresh {
  export const Event = {
    Reloaded: BusEvent.define(
      "skill.reloaded",
      z.object({
        sessionID: z.string(),
        names: z.array(z.string()),
      }),
    ),
  }

  export async function load(name: string): Promise<Entry> {
    const item = await Skill.get(name).catch(() => undefined)
    if (!item) return
    const content = await ConfigMarkdown.parse(item.location)
      .then((md) => md.content)
      .catch(() => item.content)
    return { name, content }
  }

  export async function patch(sessionID: string, read: (name: string) => Promise<Entry> = load) {
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
    console.log(`[skill dirty] reload session=${sessionID} skills=${names.join(", ")}`)
    await Bus.publish(Event.Reloaded, { sessionID, names }).catch(() => {})
    return [
      "<system-reminder>",
      "The skills below were updated. Replace any previously loaded versions with these latest versions.",
      "",
      ...list,
      "</system-reminder>",
    ].join("\n")
  }
}
