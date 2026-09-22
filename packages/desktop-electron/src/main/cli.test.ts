import { describe, expect, mock, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decodePid } from "./sidecar"

const app = {
  isPackaged: false,
  getPath: () => tmpdir(),
  getVersion: () => "0.0.0",
  setAppLogsPath: () => undefined,
  setName: () => undefined,
  setPath: () => undefined,
}

mock.module("electron", () => ({
  default: { app },
  app,
}))

function sleeper() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" })
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function exited(child: ChildProcess) {
  return new Promise<void>((resolve) => child.on("exit", () => resolve()))
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function pidRoot() {
  return mkdtempSync(join(tmpdir(), "aether-pid-"))
}

function pidFile(root: string) {
  const file = join(root, "aether", "desktop", "sidecar.pid")
  mkdirSync(join(root, "aether", "desktop"), { recursive: true })
  return file
}

describe("sidecar pid lifecycle", () => {
  test("saveSidecarPid writes a decodable record and clearSidecarPid removes it", async () => {
    const root = pidRoot()
    process.env.XDG_DATA_HOME = root
    try {
      const cli = await import("./cli")
      cli.saveSidecarPid(4242)
      const file = pidFile(root)
      expect(existsSync(file)).toBe(true)
      expect(decodePid(readFileSync(file, "utf8"), "fallback")?.pid).toBe(4242)
      cli.clearSidecarPid()
      expect(existsSync(file)).toBe(false)
      cli.clearSidecarPid()
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("stale pid reused by a foreign process is not killed and the file is removed", async () => {
    const root = pidRoot()
    process.env.XDG_DATA_HOME = root
    const child = sleeper()
    try {
      const file = pidFile(root)
      writeFileSync(file, JSON.stringify({ pid: child.pid, image: join(root, "missing", "opencode-cli.exe") }))
      const cli = await import("./cli")
      await cli.killStaleSidecar()
      expect(alive(child.pid!)).toBe(true)
      expect(existsSync(file)).toBe(false)
    } finally {
      child.kill()
      delete process.env.XDG_DATA_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("stale pid still owned by the sidecar image is killed and the file is removed", async () => {
    const root = pidRoot()
    process.env.XDG_DATA_HOME = root
    const child = sleeper()
    try {
      const file = pidFile(root)
      writeFileSync(file, JSON.stringify({ pid: child.pid, image: process.execPath }))
      const cli = await import("./cli")
      await cli.killStaleSidecar()
      await Promise.race([exited(child), wait(5000)])
      expect(alive(child.pid!)).toBe(false)
      expect(existsSync(file)).toBe(false)
    } finally {
      child.kill()
      delete process.env.XDG_DATA_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("legacy plain pid file with a dead process is removed without blocking", async () => {
    const root = pidRoot()
    process.env.XDG_DATA_HOME = root
    try {
      const file = pidFile(root)
      writeFileSync(file, "999999999\n")
      const cli = await import("./cli")
      await cli.killStaleSidecar()
      expect(existsSync(file)).toBe(false)
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("garbage pid file is removed", async () => {
    const root = pidRoot()
    process.env.XDG_DATA_HOME = root
    try {
      const file = pidFile(root)
      writeFileSync(file, "not-a-pid")
      const cli = await import("./cli")
      await cli.killStaleSidecar()
      expect(existsSync(file)).toBe(false)
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })
})
