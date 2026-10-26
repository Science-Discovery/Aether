import z from "zod"
import { NamedError } from "@opencode-ai/util/error"

export namespace Native {
  export const Permission = z.enum(["user", "auto", "full"]).meta({ ref: "NativePermission" })
  export type Permission = z.infer<typeof Permission>

  export const Config = z
    .object({
      path: z.string().trim().optional(),
      enabled: z.boolean().optional().describe("Enable Codex connections (default: true)"),
      limit: z
        .number()
        .int()
        .min(0)
        .max(16)
        .optional()
        .describe("Maximum retained idle Codex processes (default: 4; 0 disables retention)"),
    })
    .meta({ ref: "NativeCodexConfig" })

  export const Input = z
    .object({
      type: z.literal("codex"),
      model: z.string().trim().min(1).max(200).optional(),
      effort: z.string().trim().min(1).max(40).optional(),
      permission: Permission.optional().describe("Session approval mode; omitted on legacy sessions means user"),
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
