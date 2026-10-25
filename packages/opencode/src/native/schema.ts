import z from "zod"
import { NamedError } from "@opencode-ai/util/error"

export namespace Native {
  export const Input = z
    .object({
      type: z.literal("codex"),
      model: z.string().trim().min(1).max(200).optional(),
      effort: z.string().trim().min(1).max(40).optional(),
    })
    .strict()
    .meta({ ref: "NativeEngineInput" })

  export const Engine = Input.extend({
    thread: z.string().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  }).meta({ ref: "NativeEngine" })
  export type Engine = z.infer<typeof Engine>

  export const Unsupported = NamedError.create("NativeSessionUnsupported", z.object({ message: z.string() }))

  export function guard(session: { engine?: Engine }, action: string) {
    if (!session.engine) return
    throw new Unsupported({
      message: `${action} is not supported for native Codex sessions. Start a new session instead.`,
    })
  }
}
