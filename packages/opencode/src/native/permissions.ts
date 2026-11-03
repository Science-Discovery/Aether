import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import launch from "cross-spawn"
import z from "zod"
import { Shell } from "@/shell/shell"
import { Native } from "./schema"

export namespace NativePermissions {
  export const Capabilities = z
    .object({ auto: z.boolean(), error: z.string().optional() })
    .meta({ ref: "NativePermissionCapabilities" })
  export type Capabilities = z.infer<typeof Capabilities>

  const schema = z.object({
    properties: z.record(z.string(), z.unknown()),
    definitions: z.record(z.string(), z.unknown()).optional(),
    $defs: z.record(z.string(), z.unknown()).optional(),
  })
  const node = z.object({
    $ref: z.string().optional(),
    enum: z.array(z.unknown()).optional(),
    const: z.unknown().optional(),
    anyOf: z.array(z.unknown()).optional(),
    oneOf: z.array(z.unknown()).optional(),
  })

  /** Inspect the advertised parameter, not unrelated enum names or a version number. */
  export function supports(value: unknown) {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return false
    const seen = new Set<unknown>()
    const visit = (value: unknown): boolean => {
      if (seen.has(value)) return false
      seen.add(value)
      const parsed = node.safeParse(value)
      if (!parsed.success) return false
      const item = parsed.data
      if (item.enum?.includes("auto_review") || item.const === "auto_review") return true
      if (item.$ref) {
        const match = /^#\/(definitions|\$defs)\/([^/]+)$/.exec(item.$ref)
        if (match && visit(shape[match[1] as "definitions" | "$defs"]?.[match[2]])) return true
      }
      return [...(item.anyOf ?? []), ...(item.oneOf ?? [])].some(visit)
    }
    const shape = parsed.data
    return visit(parsed.data.properties.approvalsReviewer)
  }

  const cache = new Map<string, Promise<Capabilities>>()

  /** Export schemas in an isolated home. This never creates a thread or performs model inference. */
  export async function discover(file: string): Promise<Capabilities> {
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat?.isFile()) return { auto: false, error: "Codex executable could not be inspected for approval support." }
    const key = `${file}\n${stat.size}\n${stat.mtimeMs}\n${stat.ctimeMs}`
    const known = cache.get(key)
    if (known) return known
    const pending = inspect(file).catch(() => {
      cache.delete(key)
      return {
        auto: false,
        error:
          "Could not verify automatic approval support. Check the Codex executable and try again, or choose Ask for approval.",
      }
    })
    cache.set(key, pending)
    const result = await pending
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
    return result
  }

  async function inspect(file: string): Promise<Capabilities> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-codex-permissions-"))
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
      const values = await Promise.all(
        ["ThreadStartParams", "ThreadResumeParams", "TurnStartParams"].map((name) =>
          Bun.file(path.join(out, "v2", `${name}.json`)).json(),
        ),
      )
      return values.every(supports)
        ? { auto: true }
        : {
            auto: false,
            error:
              "This Codex version does not advertise automatic approval for every turn. Update Codex or choose Ask for approval.",
          }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  export function resolve(permission: Native.Permission | undefined, directory: string, capabilities?: Capabilities) {
    const mode = permission ?? "user"
    if (mode === "auto" && !capabilities?.auto)
      throw new Error(
        capabilities?.error ??
          "Automatic approval support could not be verified. Choose Ask for approval or check the Codex connection.",
      )
    const approvalPolicy = mode === "full" ? "never" : "on-request"
    const approvalsReviewer = mode === "auto" ? "auto_review" : "user"
    return {
      thread: {
        approvalPolicy,
        approvalsReviewer,
        sandbox: mode === "full" ? "danger-full-access" : "workspace-write",
      },
      turn: {
        approvalPolicy,
        approvalsReviewer,
        sandboxPolicy:
          mode === "full"
            ? { type: "dangerFullAccess" }
            : {
                type: "workspaceWrite",
                writableRoots: [directory],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
      },
    }
  }
}
