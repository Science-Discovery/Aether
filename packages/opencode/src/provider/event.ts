import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { GlobalBus } from "../bus/global"
import { Log } from "../util/log"

export namespace ProviderEvent {
  const log = Log.create({ service: "provider.event" })
  const listeners = new Set<() => void>()

  export const Event = {
    Updated: BusEvent.define("provider.updated", z.object({})),
  }

  export function onUpdated(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  export function update(publish = true) {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        log.error("invalidate failed", { error })
      }
    }
    if (!publish) return

    try {
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Event.Updated.type,
          properties: {},
        },
      })
    } catch (error) {
      log.error("publish failed", { error })
    }
  }
}
