import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const staleMs = 24 * 3600_000
export const rmOpts = {
  recursive: true,
  force: true,
  maxRetries: process.platform === "win32" ? 10 : 3,
  retryDelay: process.platform === "win32" ? 500 : 100,
} as const

const pidPath = (dir: string) => path.join(dir, "sandbox.pid")

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function sweep() {
  const names = await fs.readdir(os.tmpdir()).catch(() => [])
  await Promise.allSettled(
    names
      .filter((name) => name.startsWith("opencode-e2e-"))
      .map(async (name) => {
        const dir = path.join(os.tmpdir(), name)
        const stat = await fs.stat(dir).catch(() => undefined)
        if (!stat?.mtime) return
        if (Date.now() - stat.mtimeMs < staleMs) {
          const pid = Number(await fs.readFile(pidPath(dir), "utf8").catch(() => NaN))
          if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return
        }
        await remove(dir)
      }),
  )
}

export function remove(dir: string) {
  return fs.rm(dir, rmOpts).catch((err) => console.warn(`[e2e] failed to remove sandbox ${dir}: ${err}`))
}

export function claim(dir: string, pid: number) {
  return fs.writeFile(pidPath(dir), String(pid))
}

export async function create(label: string, pid?: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `opencode-e2e-${label}-`))
  if (pid !== undefined) await claim(dir, pid)
  return dir
}
