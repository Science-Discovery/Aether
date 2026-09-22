import { spawn } from "node:child_process"
import treeKill from "tree-kill"

export type PidRecord = { pid: number; image: string }

export type ProcInfo = { exe: string; cmdline: string }

export const WSL_IMAGE = "wsl"

const WSL_MARKER = ".opencode/bin/opencode"

const QUERY_TIMEOUT = 8000

const KILL_TIMEOUT = 3000

export function encodePid(pid: number, image: string) {
  return JSON.stringify({ pid, image })
}

export function decodePid(text: string, image: string): PidRecord | null {
  const raw = text.trim()
  if (!raw) return null
  const parsed: unknown = raw.startsWith("{") ? JSON.parse(raw) : raw
  if (typeof parsed === "number") return validPid(parsed) ? { pid: parsed, image } : null
  if (typeof parsed === "string") {
    const pid = Number.parseInt(parsed, 10)
    return validPid(pid) ? { pid, image } : null
  }
  if (parsed === null || typeof parsed !== "object") return null
  const rec = parsed as { pid?: unknown; image?: unknown }
  if (typeof rec.image !== "string" || !rec.image) return null
  return validPid(rec.pid) ? { pid: rec.pid, image: rec.image } : null
}

function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0
}

export async function running(pid: number, image: string) {
  if (process.platform === "win32") {
    const info = await winInfo(pid)
    return info !== null && ownedBy(info, image)
  }
  const line = await unixCmd(pid)
  return line !== null && line.includes(image)
}

export function ownedBy(info: ProcInfo, image: string) {
  if (image === WSL_IMAGE) {
    if (!info.exe.toLowerCase().endsWith("wsl.exe")) return false
    return info.cmdline.toLowerCase().includes(WSL_MARKER)
  }
  return samePath(info.exe, image)
}

async function winInfo(pid: number): Promise<ProcInfo | null> {
  const out = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.ExecutablePath; $p.CommandLine }`,
  ])
  const lines = out.split("\n").map((line) => line.trim())
  const exe = lines[0] ?? ""
  if (!exe) return null
  return { exe, cmdline: lines.slice(1).join(" ") }
}

async function unixCmd(pid: number): Promise<string | null> {
  const line = (await run("ps", ["-p", String(pid), "-o", "command="])).trim()
  return line || null
}

function run(cmd: string, args: string[]) {
  return new Promise<string>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let out = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve(out)
    }, QUERY_TIMEOUT)
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on("data", () => undefined)
    child.on("error", () => {
      clearTimeout(timer)
      resolve(out)
    })
    child.on("exit", () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

function samePath(a: string, b: string) {
  const norm = (value: string) => value.replace(/\//g, "\\").toLowerCase()
  return norm(a) === norm(b)
}

export async function killTree(pid: number) {
  await Promise.race([
    new Promise<void>((resolve) => treeKill(pid, "SIGKILL", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, KILL_TIMEOUT)),
  ])
}
