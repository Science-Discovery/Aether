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
    approval: z.enum(["auto", "ask"]).optional(),
  })

  export type Info = z.output<typeof Info>

  export const PreferenceChanged = BusEvent.define(
    "session.preference.changed",
    z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  )

  export function get(sessionID: string): Info | undefined {
    return store.get(sessionID)
  }

  export async function set(input: SessionPreference.Info & { source?: string }): Promise<void> {
    const { source, ...data } = input
    const prev = store.get(data.sessionID)
    const merged: SessionPreference.Info = {
      ...prev,
      ...data,
    }
    store.set(data.sessionID, merged)
    log.info("set", { sessionID: data.sessionID, source })

    if (source !== "desktop") {
      Bus.publish(PreferenceChanged, { sessionID: data.sessionID, info: merged })
    }

    if (data.approval !== undefined && data.approval !== prev?.approval) {
      const { Session } = await import(".")
      if (data.approval === "auto") {
        await Session.setPermission({
          sessionID: data.sessionID,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
      } else if (data.approval === "ask") {
        await Session.setPermission({
          sessionID: data.sessionID,
          permission: [],
        })
      }
    }
  }

  export function remove(sessionID: string): void {
    store.delete(sessionID)
  }

  export function clear(): void {
    store.clear()
  }
}
