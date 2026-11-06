import z from "zod"

/**
 * ACP-backed agent engines. Codex keeps its own `Native.Engine` metadata so the
 * existing app-server integration is untouched.
 */
export namespace Engine {
  export const ID = z.enum(["qoder", "qodercn", "opencode", "claude"]).meta({ ref: "EngineID" })
  export type ID = z.infer<typeof ID>

  export const Permission = z.enum(["user", "auto", "full"]).meta({ ref: "EnginePermission" })
  export type Permission = z.infer<typeof Permission>

  export const Model = z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .meta({ ref: "EngineModel" })
  export type Model = z.infer<typeof Model>

  export const Option = z
    .object({
      value: z.string(),
      name: z.string(),
      description: z.string().optional(),
    })
    .meta({ ref: "EngineConfigValue" })

  export const Config = z
    .object({
      id: z.string(),
      name: z.string(),
      category: z.string().optional(),
      type: z.string(),
      value: z.string().optional(),
      options: z.array(Option).default([]),
    })
    .meta({ ref: "EngineConfigOption" })
  export type Config = z.infer<typeof Config>

  export const Input = z
    .object({
      type: ID,
      model: z.string().trim().min(1).max(200).optional(),
      effort: z.string().trim().min(1).max(80).optional(),
      mode: z.string().trim().min(1).max(80).optional(),
      permission: Permission.optional().describe("How ACP permission requests are answered"),
    })
    .strict()
    .meta({ ref: "EngineInput" })
  export type Input = z.infer<typeof Input>

  export const Info = Input.extend({
    session: z.string().min(1).max(500).optional().describe("Provider-side conversation identifier"),
    models: z.array(Model).optional(),
    config: z.array(Config).optional(),
  }).meta({ ref: "EngineInfo" })
  export type Info = z.infer<typeof Info>

  export const Status = z
    .object({
      id: ID,
      name: z.string(),
      installed: z.boolean(),
      path: z.string().optional(),
      version: z.string().optional(),
      protocol: z.enum(["acp", "claude"]),
      error: z.string().optional(),
    })
    .meta({ ref: "EngineStatus" })
  export type Status = z.infer<typeof Status>
}
