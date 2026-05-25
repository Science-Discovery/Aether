import z from "zod"
import { BusEvent } from "@/bus/bus-event"

/** Published after a skill is successfully written to the shadow directory. */
export const SkillSavedEvent = BusEvent.define("skill.saved", z.object({}))

export namespace Publisher {
  /**
   * Publish the skill.saved event.
   * Subscribers (e.g. the UI) use this to refresh skill listings.
   */
  export async function publishSkillSaved(): Promise<void> {
    const { Bus } = await import("@/bus")
    await Bus.publish(SkillSavedEvent, {})
  }
}
