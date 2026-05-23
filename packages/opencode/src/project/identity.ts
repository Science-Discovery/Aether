import { existsSync, readFileSync, statSync } from "fs"
import path from "path"
import { ProjectID } from "./schema"

export namespace ProjectIdentity {
  export type Info = {
    id: ProjectID
    root: string
    sandbox: string
    vcs?: "git"
  }

  export function norm(input: string) {
    const next = path.resolve(input).replace(/\\/g, "/")
    const result = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
    const out = process.platform === "win32" ? result.replace(/\//g, "\\") : result
    if (process.platform === "win32" && /^[A-Za-z]:$/.test(out)) return out + "\\"
    return out
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
