import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Log } from "@/util/log"

const log = Log.create({ service: "session.preference" })

const store = new Map<string, SessionPreference.Info>()

export namespace SessionPreference {
  export const Info = z.object({
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    variant: z.string().optional(),
    autoAccept: z.boolean().optional(),
  })

  export type Info = z.output<typeof Info>

  export const Patch = z.object({
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    variant: z.string().optional(),
    autoAccept: z.boolean().optional(),
  })

  export type Patch = z.output<typeof Patch>

  export const PreferenceUpdated = BusEvent.define(
    "session.preference.updated",
    z.object({
      sessionID: SessionID.zod,
      preference: Info,
    }),
  )

  export function get(sessionID: string): Info | undefined {
    return store.get(sessionID)
  }

  export async function update(patch: Patch): Promise<Info> {
    const prev = store.get(patch.sessionID)
    const merged: Info = {
      sessionID: patch.sessionID,
      agent: patch.agent ?? prev?.agent,
      model: patch.model ?? prev?.model,
      variant: patch.variant ?? prev?.variant,
      autoAccept: patch.autoAccept ?? prev?.autoAccept,
    }
    store.set(patch.sessionID, merged)
    log.info("update", { sessionID: patch.sessionID })

    Bus.publish(PreferenceUpdated, { sessionID: patch.sessionID, preference: merged })

    if (patch.autoAccept !== undefined && patch.autoAccept !== prev?.autoAccept) {
      const { Session } = await import(".")
      if (patch.autoAccept) {
        await Session.setPermission({
          sessionID: patch.sessionID,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
      } else {
        await Session.setPermission({
          sessionID: patch.sessionID,
          permission: [],
        })
      }
    }

    return merged
  }

  export function remove(sessionID: string): void {
    store.delete(sessionID)
  }

  export function clear(): void {
    store.clear()
  }
}
