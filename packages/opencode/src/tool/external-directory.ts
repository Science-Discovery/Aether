import path from "path"
import { lstatSync, readlinkSync, realpathSync } from "fs"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"

type Kind = "file" | "directory"
type Access = "read" | "write"

type Options = {
  bypass?: boolean
  kind?: Kind
  access?: Access
}

// A symlink/junction inside the project can alias paths outside of it, so the
// guard must judge containment on the resolved access target, never the alias.
const maxHops = 32

function canonical(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

function readlink(p: string): string | undefined {
  try {
    return readlinkSync(p)
  } catch {
    return undefined
  }
}

// Resolve the real access destination: follow links on existing paths, and for
// missing paths resolve the nearest existing ancestor (following dangling
// links met along the way) then re-join the trailing segments. Returns
// undefined when the destination cannot be determined; the guard then fails
// closed and asks.
function resolveTarget(target: string): string | undefined {
  let current = path.resolve(Filesystem.windowsPath(target))
  const rest: string[] = []
  let hops = 0
  while (true) {
    const real = canonical(current)
    if (real) return rest.length === 0 ? real : path.join(real, ...rest.reverse())
    const dest = lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() ? readlink(current) : undefined
    if (dest) {
      hops += 1
      if (hops > maxHops) return undefined
      current = path.resolve(path.dirname(current), Filesystem.windowsPath(dest))
      continue
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    rest.push(path.basename(current))
    current = parent
  }
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  const real = resolveTarget(target)
  if (real && Instance.containsPath(real)) return

  const kind = options?.kind ?? "file"
  const parentDir = kind === "directory" ? target : path.dirname(target)
  const glob = path.join(parentDir, "*").replaceAll("\\", "/")
  const permission = options?.access === "read" ? "external_read" : "external_directory"

  await ctx.ask({
    permission,
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: target,
      parentDir,
    },
  })
}
