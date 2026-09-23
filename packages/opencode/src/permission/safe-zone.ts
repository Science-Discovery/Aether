import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@/global"
import type { Permission } from "./index"

export namespace SafeZone {
  export type Config = {
    private?: string[]
    open?: string[]
  }

  const slash = (p: string) => p.replaceAll("\\", "/")

  function expand(glob: string): string {
    const home = os.homedir()
    if (glob.startsWith("~/")) return path.join(home, glob.slice(2))
    if (glob === "~") return home
    if (glob.startsWith("$HOME/")) return path.join(home, glob.slice(6))
    if (glob.startsWith("$HOME")) return path.join(home, glob.slice(5))
    return glob
  }

  function absForm(glob: string, worktree: string): string {
    const raw = expand(glob)
    const joined = path.isAbsolute(raw) ? raw : path.join(worktree, raw)
    return slash(joined)
  }

  function zoneRules(globs: string[], action: "allow" | "deny", worktree: string): Permission.Ruleset {
    const out: Permission.Ruleset = []
    for (const raw of globs) {
      if (!raw) continue
      const base = raw.replace(/[\\/]+$/, "")
      const list = /[*?]/.test(base) ? [base] : [base, `${base}/**`]
      for (const glob of list) {
        const expanded = expand(glob)
        const relative = !path.isAbsolute(expanded)
        // Basename/relative globs must also match anywhere, like permission-config
        // globs; the worktree-joined form adds scoped coverage for dir globs.
        const abs = relative ? [slash(expanded), slash(path.join(worktree, expanded))] : [slash(expanded)]
        const rel = relative ? slash(expanded) : slash(path.relative(worktree, expanded))
        for (const pattern of abs) {
          out.push({ permission: "read", pattern, action })
          out.push({ permission: "external_read", pattern, action })
          out.push({ permission: "external_directory", pattern, action })
        }
        out.push({ permission: "edit", pattern: rel, action })
      }
    }
    return out
  }

  async function real(glob: string): Promise<string[]> {
    const cut = glob.search(/[*?]/)
    const dir = cut === -1 ? glob : glob.slice(0, cut)
    const tail = cut === -1 ? "" : glob.slice(cut)
    const resolved = await fs.realpath(dir).catch(() => undefined)
    if (!resolved || slash(resolved) === slash(dir)) return [glob]
    return [glob, slash(path.join(resolved, tail))]
  }

  export async function builtins(): Promise<Required<Config>> {
    const roots = [os.tmpdir(), Global.Path.data, Global.Path.cache]
    const open: string[] = []
    for (const root of roots) {
      for (const form of await real(`${slash(root)}/**`)) {
        if (!open.includes(form)) open.push(form)
      }
    }
    const data = slash(Global.Path.data)
    const memo = slash(path.join(Global.Path.data, "memory"))
    const secret: string[] = [
      `${data}/auth.json*`,
      "*.db",
      "*.db-wal",
      "*.db-shm",
      `${memo}/AETHER_MEMORY*`,
      `${data}/log/**`,
    ]
    return { open, private: secret }
  }

  // Order matters: findLast evaluation means later layers win.
  // built-in open < built-in private < user open < user private (fail-closed).
  export async function rules(safeZone: Config | undefined, worktree: string): Promise<Permission.Ruleset> {
    const zone: Required<Config> = {
      open: safeZone?.open ?? [],
      private: safeZone?.private ?? [],
    }
    const inner = await builtins()
    return [
      { permission: "external_read", pattern: "*", action: "allow" },
      ...zoneRules(inner.open, "allow", worktree),
      ...zoneRules(inner.private, "deny", worktree),
      ...zoneRules(zone.open, "allow", worktree),
      ...zoneRules(zone.private, "deny", worktree),
    ]
  }
}
