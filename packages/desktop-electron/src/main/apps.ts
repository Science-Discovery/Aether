import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export function checkAppExists(appName: string): boolean {
  if (process.platform === "win32") return true
  if (process.platform === "linux") return true
  return checkMacosApp(appName)
}

export function wslPath(path: string, mode: "windows" | "linux" | null): string {
  if (process.platform !== "win32") return path

  const flag = mode === "windows" ? "-w" : "-u"
  try {
    const target = path.startsWith("~") ? wslHome() + path.slice(1) : path
    const output = execFileSync("wsl", ["-e", "wslpath", flag, target])
    return output.toString().trim()
  } catch (error) {
    throw new Error(`Failed to run wslpath: ${String(error)}`)
  }
}

function wslHome(): string {
  const output = execFileSync("wsl", ["-e", "sh", "-lc", 'printf %s "$HOME"'])
  return output.toString().trim()
}

function checkMacosApp(appName: string) {
  const locations = [`/Applications/${appName}.app`, `/System/Applications/${appName}.app`]

  const home = process.env.HOME
  if (home) locations.push(`${home}/Applications/${appName}.app`)

  if (locations.some((location) => existsSync(location))) return true

  try {
    execFileSync("which", [appName])
    return true
  } catch {
    return false
  }
}
