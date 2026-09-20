import { existsSync, readFileSync, realpathSync, statSync } from "fs"
import path from "path"
import { Global } from "../global"
import { ProjectID } from "./schema"

export namespace ProjectIdentity {
  export type Info = {
    id: ProjectID
    root: string
    sandbox: string
    vcs?: "git"
    kind?: "subdirectory"
  }

  export function norm(input: string) {
    const next = path.resolve(input).replace(/\\/g, "/")
    const result = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
    if (process.platform === "win32" && /^[A-Za-z]:/.test(result)) {
      const out = result.replace(/\//g, "\\")
      if (/^[A-Za-z]:$/.test(out)) return out + "\\"
      return out
    }
    return result
  }

  function marker(dir: string): string | undefined {
    let cur = path.resolve(dir)
    while (true) {
      const git = path.join(cur, ".git")
      if (existsSync(git)) return git
      const parent = path.dirname(cur)
      if (parent === cur) return
      cur = parent
    }
  }

  function common(file: string) {
    try {
      if (!statSync(file).isFile()) return
      const match = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(file, "utf-8"))
      if (!match) return
      const dir = path.resolve(path.dirname(file), match[1])
      const idx = dir.replace(/\\/g, "/").lastIndexOf("/worktrees/")
      if (idx < 0) return
      return dir.slice(0, idx)
    } catch {
      return
    }
  }

  // Directories inside the app's own worktree storage are not user workspace
  // territory: whatever sits there belongs to the project that owns the
  // container, so usage in managed storage can never mint a standalone project.
  // Both sides go through realpath so a relocated data home (test replay) whose
  // worktree dir is a junction to the real one still matches by string prefix.
  export function managed(dir: string) {
    const ci = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s)
    const under = (next: string, root: string) =>
      next === root || next.startsWith(root + "\\") || next.startsWith(root + "/")
    const root = ci(norm(path.join(Global.Path.data, "worktree")))
    const next = ci(norm(dir))
    if (under(next, root)) return true
    try {
      return under(ci(norm(realpathSync(next))), ci(norm(realpathSync(root))))
    } catch {
      return false
    }
  }

  export function resolve(dir: string): Info {
    const git = marker(dir)
    if (!git) {
      const root = path.resolve(dir)
      return {
        id: ProjectID.fromDirectory(norm(root)),
        root,
        sandbox: root,
      }
    }

    const sandbox = path.dirname(git)

    if (norm(path.resolve(dir)) !== norm(sandbox) && !managed(sandbox)) {
      const root = path.resolve(dir)
      return {
        id: ProjectID.fromDirectory(norm(root)),
        root,
        sandbox: root,
        vcs: "git",
        kind: "subdirectory",
      }
    }

    const root = (() => {
      try {
        if (statSync(git).isDirectory()) return sandbox
      } catch {
        return sandbox
      }
      const base = common(git)
      if (!base) return sandbox
      return path.dirname(base)
    })()

    return {
      id: ProjectID.fromDirectory(norm(root)),
      root,
      sandbox,
      vcs: "git",
    }
  }
}
