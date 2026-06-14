import { release } from "os"
import path from "path"
import { existsSync } from "fs"
import { Spawner } from "./spawner"

export interface RevealPlan {
  cmd: string
  args: string[]
}

/**
 * Pure decision: which command opens `dir` in the system file manager.
 *
 * WSL is the tricky case (verified by experiment): explorer.exe does NOT accept
 * a raw /home/... path, but DOES accept the `wslpath -w` form
 * (\\wsl.localhost\<distro>\...). So under WSL we convert first via the injected
 * `toWindows`, then call explorer.exe. Plain win32 → explorer.exe; macOS → open;
 * plain Linux → xdg-open.
 */
export function resolveReveal(input: {
  platform: NodeJS.Platform
  isWsl: boolean
  dir: string
  toWindows: (p: string) => string
}): RevealPlan {
  if (input.isWsl) return { cmd: "explorer.exe", args: [input.toWindows(input.dir)] }
  if (input.platform === "win32") return { cmd: "explorer.exe", args: [input.dir] }
  if (input.platform === "darwin") return { cmd: "open", args: [input.dir] }
  return { cmd: "xdg-open", args: [input.dir] }
}

/**
 * Security guard: is `dir` the same as, or nested under, `root`? Compares
 * normalized absolute paths segment-by-segment via `path.relative`, so it is not
 * fooled by `..` traversal or by a sibling that merely shares the root's string
 * prefix (e.g. "<root>-evil").
 */
export function isPathInRoot(dir: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(dir))
  if (rel === "") return true // dir === root
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Pure decision: given the command we launched and its exit code, did the open
 * succeed? Windows explorer.exe routinely returns a non-zero exit code even when
 * it DID open the folder, so we never treat its non-zero as failure. Every other
 * launcher (open, xdg-open) follows the usual 0 = success rule — which is what
 * lets us actually report failure when e.g. xdg-open has no desktop to open into.
 */
export function isRevealSuccess(cmd: string, exitCode: number): boolean {
  if (cmd === "explorer.exe") return true
  return exitCode === 0
}

function isWsl(rel = release()): boolean {
  return rel.toUpperCase().includes("WSL")
}

/** Convert a WSL path to its Windows form using the system `wslpath -w`. */
async function wslToWindows(p: string): Promise<string> {
  const proc = Bun.spawn(["wslpath", "-w", p])
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

/**
 * Open `dir` in the system file manager. Cross-platform, WSL-aware, and runs in
 * the backend process (which has OS access) so it works even when the UI is a
 * plain browser tab. Best-effort: returns false instead of throwing.
 *
 * Refuses to open anything outside the skill-evolution root — the directory must
 * exist and live under it — so a crafted request can't open an arbitrary path.
 */
export async function revealPath(dir: string): Promise<boolean> {
  const root = Spawner.skillEvolutionRoot()
  if (!isPathInRoot(dir, root)) return false
  if (!existsSync(dir)) return false
  const wsl = isWsl()
  try {
    // For WSL the conversion needs an async system call, so resolve it up front and
    // feed resolveReveal a synchronous toWindows that returns the precomputed value.
    const winPath = wsl ? await wslToWindows(dir) : dir
    const plan = resolveReveal({ platform: process.platform, isWsl: wsl, dir, toWindows: () => winPath })
    const proc = Bun.spawn([plan.cmd, ...plan.args])
    const exitCode = await proc.exited
    return isRevealSuccess(plan.cmd, exitCode)
  } catch {
    return false
  }
}
