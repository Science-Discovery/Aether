import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { MessageID, SessionID } from "@/session/schema"

export namespace Native {
  export const Mode = z.enum(["default", "plan"]).meta({ ref: "NativeMode" })
  export type Mode = z.infer<typeof Mode>
  export const Active = z
    .object({
      phase: z.enum(["starting", "running", "waiting", "stopping"]),
      threadID: z.string().optional(),
      turnID: z.string().optional(),
      mode: Mode,
      steer: z.boolean(),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeActive" })
  export type Active = z.infer<typeof Active>
  export const Steer = z
    .object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      turnID: z.string().min(1),
      text: z.string().trim().min(1).max(100_000),
    })
    .strict()
    .meta({ ref: "NativeSteer" })
  export type Steer = z.infer<typeof Steer>
  export const Steered = z
    .object({
      status: z.enum(["accepted", "rejected", "uncertain"]),
      messageID: MessageID.zod,
      turnID: z.string(),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeSteered" })
  export type Steered = z.infer<typeof Steered>
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
      mode: Mode.optional().describe("Native collaboration mode; omitted means default"),
      permission: Permission.optional().describe("Session approval mode; omitted on legacy sessions means user"),
    })
    .strict()
    .meta({ ref: "NativeEngineInput" })

  export const Engine = Input.extend({
    collaboration: Mode.optional().describe("Last collaboration mode dispatched to the native thread"),
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
