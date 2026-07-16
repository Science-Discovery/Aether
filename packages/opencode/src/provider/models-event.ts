import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { GlobalBus } from "../bus/global"

export namespace ProviderModels {
  export const Event = {
    Updated: BusEvent.define(
      "provider.models.updated",
      z.object({
        checkedAt: z.number(),
        updatedAt: z.number(),
        hash: z.string(),
        source: z.enum(["models.dev", "codex"]).optional(),
      }),
    ),
  }

  export function emit(input: z.infer<typeof Event.Updated.properties>) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Event.Updated.type,
        properties: input,
      },
    })
  }
}
