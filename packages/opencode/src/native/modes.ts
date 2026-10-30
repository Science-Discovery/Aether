import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import launch from "cross-spawn"
import z from "zod"
import { Shell } from "@/shell/shell"
import type { Protocol } from "./protocol"

export namespace NativeModes {
  export const Capabilities = z
    .object({ steer: z.boolean(), plan: z.boolean(), research: z.boolean().optional(), error: z.string().optional() })
    .meta({ ref: "NativeModeCapabilities" })
  export type Capabilities = z.infer<typeof Capabilities>

  const record = z.record(z.string(), z.unknown())
  const preset = z.object({
    name: z.string().min(1).max(200),
    mode: z.string().nullable().optional(),
    model: z.string().min(1).max(200).nullable().optional(),
    reasoning_effort: z.string().min(1).max(40).nullable().optional(),
  })
  const response = z.object({ data: z.array(preset).max(1000) })
  type Documents = {
    steer: unknown
    start: unknown
    list: unknown
    requests: unknown
    thread?: unknown
    callbacks?: unknown
  }

  const object = (value: unknown) => record.safeParse(value).data ?? {}
  function variants(root: unknown, value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
    if (seen.has(value) || seen.size >= 64) return []
    seen.add(value)
    const item = object(value)
    const ref = typeof item.$ref === "string" ? /^#\/(definitions|\$defs)\/([^/]+)$/.exec(item.$ref) : undefined
    return [
      item,
      ...(ref ? variants(root, object(object(root)[ref[1]])[ref[2]], seen) : []),
      ...[item.anyOf, item.oneOf, item.allOf]
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .flatMap((value) => variants(root, value, seen)),
    ]
  }

  const property = (root: unknown, value: unknown, key: string) =>
    variants(root, value).flatMap((item) => variants(root, object(item.properties)[key]))
  const typed = (nodes: Record<string, unknown>[], type: string) =>
    nodes.some((item) => item.type === type || (Array.isArray(item.type) && item.type.includes(type)))
  const literal = (nodes: Record<string, unknown>[], value: string) =>
    nodes.some((item) => item.const === value || (Array.isArray(item.enum) && item.enum.includes(value)))

  /** Follow the actual request fields; unrelated type names do not prove support. */
  export function supports(docs: Documents): Capabilities {
    const requests = object(docs.requests)
    const methods = [
      requests,
      ...[requests.oneOf, requests.anyOf].flatMap((value) => (Array.isArray(value) ? value : [])),
    ]
      .slice(0, 1000)
      .flatMap((item) => property(docs.requests, item, "method"))
    const required = object(docs.steer).required
    const steer =
      literal(methods, "turn/steer") &&
      Array.isArray(required) &&
      ["threadId", "input", "expectedTurnId"].every((name) => required.includes(name)) &&
      ["threadId", "expectedTurnId", "clientUserMessageId"].every((name) =>
        typed(property(docs.steer, docs.steer, name), "string"),
      ) &&
      property(docs.steer, docs.steer, "input").some(
        (item) =>
          item.type === "array" &&
          variants(docs.steer, item.items).some(
            (item) =>
              literal(property(docs.steer, item, "type"), "text") &&
              typed(property(docs.steer, item, "text"), "string"),
          ),
      )
    const mode = property(docs.start, docs.start, "collaborationMode")
    const plan =
      literal(methods, "collaborationMode/list") &&
      literal(methods, "turn/start") &&
      mode.some(
        (item) =>
          ["default", "plan"].every((value) => literal(property(docs.start, item, "mode"), value)) &&
          property(docs.start, item, "settings").some(
            (item) =>
              typed(property(docs.start, item, "model"), "string") &&
              typed(property(docs.start, item, "reasoning_effort"), "string") &&
              typed(property(docs.start, item, "reasoning_effort"), "null") &&
              typed(property(docs.start, item, "developer_instructions"), "null"),
          ),
      ) &&
      property(docs.list, docs.list, "data").some(
        (item) =>
          item.type === "array" &&
          typed(property(docs.list, item.items, "name"), "string") &&
          ["default", "plan"].every((value) => literal(property(docs.list, item.items, "mode"), value)),
      )
    return {
      steer,
      plan,
      ...(research(docs.thread, docs.callbacks) ? { research: true } : {}),
      ...(!steer || !plan
        ? { error: "This Codex version does not advertise all required steering and collaboration mode fields." }
        : {}),
    }
  }

  function research(thread: unknown, callbacks: unknown) {
    const tools = property(thread, thread, "dynamicTools")
    const registered = tools.some(
      (item) =>
        typed([item], "array") &&
        variants(thread, item.items).some(
          (item) =>
            literal(property(thread, item, "type"), "function") &&
            ["name", "description"].every((name) => typed(property(thread, item, name), "string")) &&
            Object.hasOwn(object(item.properties), "inputSchema"),
        ),
    )
    return (
      registered &&
      variants(callbacks, callbacks).some(
        (item) =>
          literal(property(callbacks, item, "method"), "item/tool/call") &&
          property(callbacks, item, "params").some(
            (item) =>
              ["threadId", "turnId", "callId", "tool"].every((name) =>
                typed(property(callbacks, item, name), "string"),
              ) && Object.hasOwn(object(item.properties), "arguments"),
          ),
      )
    )
  }

  const cache = new Map<string, { value: Promise<Capabilities>; expires: number }>()

  /** Export schemas with an empty home; never initialize an account or create a thread. */
  export async function discover(file: string): Promise<Capabilities> {
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat?.isFile()) return { steer: false, plan: false, error: "The Codex executable could not be inspected." }
    const key = `${file}\n${stat.size}\n${stat.mtimeMs}\n${stat.ctimeMs}`
    const known = cache.get(key)
    if (known && known.expires > Date.now()) return known.value
    const entry = {
      expires: Infinity,
      value: inspect(file)
        .catch(() => ({
          steer: false,
          plan: false,
          error: "Could not verify Codex steering and collaboration mode support.",
        }))
        .then((value) => {
          if (value.error) entry.expires = Date.now() + 30_000
          return value
        }),
    }
    cache.set(key, entry)
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
    return entry.value
  }

  async function inspect(file: string): Promise<Capabilities> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-codex-modes-"))
    try {
      const home = path.join(root, "home")
      const out = path.join(root, "schema")
      await fs.mkdir(home)
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(key)),
      )
      const child = launch(file, ["app-server", "generate-json-schema", "--out", out, "--experimental"], {
        cwd: root,
        env: {
          ...env,
          CODEX_HOME: home,
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
        },
        stdio: "ignore",
        windowsHide: true,
        detached: process.platform !== "win32",
      })
      const done = Promise.withResolvers<void>()
      const exited = () => child.exitCode !== null || child.signalCode !== null
      child.once("error", done.reject)
      child.once("exit", (code) => {
        if (code === 0) return done.resolve()
        done.reject(new Error("Codex schema export failed"))
      })
      const timer = setTimeout(() => done.reject(new Error("Codex schema export timed out")), 10_000)
      try {
        await done.promise
      } finally {
        clearTimeout(timer)
        if (!exited()) {
          await Promise.race([Shell.killTree(child, { exited }), Bun.sleep(2_000)]).catch(() => undefined)
          if (!exited()) child.kill("SIGKILL")
        }
      }
      const read = (file: string) =>
        Bun.file(path.join(out, file))
          .json()
          .catch(() => undefined)
      const [steer, start, list, requests, thread, callbacks] = await Promise.all([
        read("v2/TurnSteerParams.json"),
        read("v2/TurnStartParams.json"),
        read("v2/CollaborationModeListResponse.json"),
        read("ClientRequest.json"),
        read("v2/ThreadStartParams.json"),
        read("ServerRequest.json"),
      ])
      return supports({ steer, start, list, requests, thread, callbacks })
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  export async function list(client: Pick<Protocol.Client, "request">) {
    const value = response.safeParse(await client.request("collaborationMode/list", {}, { timeout: 5_000 }))
    if (!value.success) throw new Error("Codex returned an unsupported collaboration mode preset list.")
    return value.data.data.filter((item) => item.mode === "default" || item.mode === "plan")
  }

  export async function resolve(
    client: Pick<Protocol.Client, "request">,
    input: { mode: "default" | "plan"; model: string; effort?: string; previous?: "default" | "plan" },
    capabilities: Capabilities,
  ) {
    if (!capabilities.plan) {
      if (input.mode === "default" && input.previous === "plan")
        throw new Error(
          "Cannot verify a switch from native plan mode to default; the existing thread may retain plan mode.",
        )
      if (input.mode === "default") return
      throw new Error(capabilities.error ?? "This Codex version does not support native plan mode.")
    }
    const preset = (await list(client)).find((item) => item.mode === input.mode)
    if (!preset) throw new Error(`Codex did not advertise the requested ${input.mode} collaboration mode preset.`)
    return {
      mode: input.mode,
      settings: {
        model: input.model,
        reasoning_effort: input.effort ?? preset.reasoning_effort ?? null,
        developer_instructions: null,
      },
    }
  }
}
