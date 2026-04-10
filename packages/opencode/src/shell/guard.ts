import path from "path"
import fs from "fs/promises"
import { Log } from "@/util/log"

const log = Log.create({ service: "shell-guard" })

export async function cleanupNul(cwd: string) {
  if (process.platform !== "win32") return
  const p = path.join(cwd, "nul")
  try {
    const stat = await fs.stat(p)
    if (stat.isFile()) {
      await fs.unlink(p)
      log.info("removed accidental nul file", { path: p })
    }
  } catch {}
}
