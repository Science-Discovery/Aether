import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Codex } from "./codex"
import type { Protocol } from "./protocol"

export namespace NativeSkills {
  export const Selection = z.object({ name: z.string().trim().min(1).max(200), path: z.string().min(1).max(4096) })
  const Skill = Selection.extend({ description: z.string(), displayName: z.string().optional() })
  export const Status = z
    .object({
      state: z.enum(["ready", "unavailable", "disabled"]),
      skills: z.array(Skill),
      errors: z.array(z.string()),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeCodexSkills" })
  export type Status = z.infer<typeof Status>

  const cache = Instance.state(() => new Map<string, { expires: number; promise: Promise<Status> }>())
  const entry = Selection.extend({
    enabled: z.boolean(),
    description: z.string(),
    shortDescription: z.string().optional(),
    interface: z.object({ displayName: z.string().optional(), shortDescription: z.string().optional() }).optional(),
  })
  const catalog = z.object({
    data: z
      .array(
        z.object({
          cwd: z.string(),
          skills: z.array(z.unknown()).max(5000),
          errors: z.array(z.object({ path: z.string(), message: z.string() })),
        }),
      )
      .max(100),
  })

  /** Only advertise skills that the native server enabled for this project. */
  export function parse(value: unknown, cwd: string): Status {
    const result = catalog.parse(value).data.filter((item) => Filesystem.resolve(item.cwd) === Filesystem.resolve(cwd))
    if (result.length !== 1) throw new Error("Codex did not return a unique skill catalog for this project.")
    const errors = result[0].errors.map((item) => `${item.path}: ${item.message}`)
    const skills = new Map<string, z.infer<typeof Skill>>()
    for (const value of result[0].skills) {
      const item = entry.safeParse(value)
      if (!item.success) {
        errors.push("Codex returned an invalid skill entry; refresh after checking its configuration.")
        continue
      }
      if (!item.data.enabled) continue
      const skill = {
        name: item.data.name,
        path: item.data.path,
        description: item.data.interface?.shortDescription ?? item.data.shortDescription ?? item.data.description,
        displayName: item.data.interface?.displayName,
      }
      skills.set(JSON.stringify([skill.name, skill.path]), skill)
    }
    return { state: "ready", skills: [...skills.values()], errors }
  }

  async function list(client: Pick<Protocol.Client, "request">, cwd: string, signal?: AbortSignal) {
    return parse(
      await client.request("skills/list", { cwds: [cwd], forceReload: true }, { signal, timeout: 15_000 }),
      cwd,
    )
  }

  /** Revalidate on the actual execution connection, including queued and steered input. */
  export async function validate(
    skills: z.infer<typeof Selection>[],
    client: Pick<Protocol.Client, "request">,
    cwd: string,
    signal: AbortSignal,
  ) {
    if (!skills.length) return
    const result = await list(client, cwd, signal)
    for (const skill of skills) {
      if (!result.skills.some((item) => item.name === skill.name && item.path === skill.path))
        throw new Error(
          `Codex skill ${skill.name} is no longer available for this project. Refresh the skill list and select it again.`,
        )
    }
  }

  async function probe(file: string | undefined, cwd: string): Promise<Status> {
    const connection = await Codex.connect({ executable: file, cwd, signal: AbortSignal.timeout(20_000) })
    return list(connection.client, cwd).finally(() => connection.client.close())
  }

  export async function read(opts: { refresh?: boolean } = {}): Promise<Status> {
    const cfg = (await Config.getGlobal()).native?.codex
    if (cfg?.enabled === false) {
      cache().clear()
      return { state: "disabled", skills: [], errors: [] }
    }
    const key = JSON.stringify([Global.Path.config, process.env.CODEX_HOME ?? "", cfg?.path?.trim() ?? ""])
    const previous = cache().get(key)
    const value =
      previous && (previous.expires === Infinity || (!opts.refresh && previous.expires > Date.now()))
        ? previous
        : {
            expires: Infinity,
            promise: probe(cfg?.path, Instance.directory).catch(
              (error: unknown): Status => ({
                state: "unavailable",
                skills: [],
                errors: [],
                error:
                  error instanceof Error
                    ? error.message
                    : "Codex skills are unavailable. Check the connection and try again.",
              }),
            ),
          }
    cache().clear()
    cache().set(key, value)
    const result = await value.promise
    if (value.expires === Infinity) value.expires = Date.now() + (result.state === "ready" ? 30_000 : 5_000)
    const current = (await Config.getGlobal()).native?.codex
    if (current?.enabled === false) return { state: "disabled", skills: [], errors: [] }
    if (key !== JSON.stringify([Global.Path.config, process.env.CODEX_HOME ?? "", current?.path?.trim() ?? ""]))
      return {
        state: "unavailable",
        skills: [],
        errors: [],
        error: "Codex configuration changed. Refresh the skill list.",
      }
    return result
  }
}
