import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

// We import the module under test after setting up mocks
describe("util.python-resolver", () => {
  // Store original platform
  const originalPlatform = process.platform
  const originalEnv = process.env

  function mockPlatform(platform: string) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true })
  }

  function restorePlatform() {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
  }

  describe("resolvePythonCommand", () => {
    test("returns 'python' on Windows", async () => {
      mockPlatform("win32")
      // Dynamic import to pick up the platform change
      const { resolvePythonCommand } = await import("../../src/util/python-resolver")
      const result = resolvePythonCommand()
      expect(result).toBe("python")
      restorePlatform()
    })

    test("returns 'python3' on macOS", async () => {
      mockPlatform("darwin")
      const { resolvePythonCommand } = await import("../../src/util/python-resolver")
      const result = resolvePythonCommand()
      expect(result).toBe("python3")
      restorePlatform()
    })

    test("returns 'python3' on Linux", async () => {
      mockPlatform("linux")
      const { resolvePythonCommand } = await import("../../src/util/python-resolver")
      const result = resolvePythonCommand()
      expect(result).toBe("python3")
      restorePlatform()
    })
  })

  describe("getPythonCandidates", () => {
    test("includes Windows-specific paths on win32", async () => {
      mockPlatform("win32")
      const { getPythonCandidates } = await import("../../src/util/python-resolver")
      const candidates = getPythonCandidates()
      expect(candidates[0]).toBe("python")
      // Should NOT include Unix-only paths
      expect(candidates).not.toContain("/usr/bin/python3")
      expect(candidates).not.toContain("/usr/local/bin/python3")
      restorePlatform()
    })

    test("includes Unix paths on darwin", async () => {
      mockPlatform("darwin")
      const { getPythonCandidates } = await import("../../src/util/python-resolver")
      const candidates = getPythonCandidates()
      expect(candidates[0]).toBe("python3")
      expect(candidates).toContain("python")
      expect(candidates).toContain("/usr/bin/python3")
      expect(candidates).toContain("/usr/local/bin/python3")
      restorePlatform()
    })
  })

  describe("findVenvPython", () => {
    test("returns venv python path when .venv exists (Unix)", async () => {
      const { findVenvPython } = await import("../../src/util/python-resolver")
      // Create a temporary directory structure
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-resolver-test-"))
      const venvBin = path.join(tmpDir, ".venv", "bin")
      fs.mkdirSync(venvBin, { recursive: true })
      const pythonPath = path.join(venvBin, "python")
      fs.writeFileSync(pythonPath, "", { mode: 0o755 })

      mockPlatform("darwin")
      const result = findVenvPython(tmpDir)
      expect(result).toBe(pythonPath)

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true })
      restorePlatform()
    })

    test("returns venv python path when .venv exists (Windows)", async () => {
      const { findVenvPython } = await import("../../src/util/python-resolver")
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-resolver-test-"))
      const venvScripts = path.join(tmpDir, ".venv", "Scripts")
      fs.mkdirSync(venvScripts, { recursive: true })
      const pythonExe = path.join(venvScripts, "python.exe")
      fs.writeFileSync(pythonExe, "")

      mockPlatform("win32")
      const result = findVenvPython(tmpDir)
      expect(result).toBe(pythonExe)

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true })
      restorePlatform()
    })

    test("returns venv python path when venv/ exists (Unix)", async () => {
      const { findVenvPython } = await import("../../src/util/python-resolver")
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-resolver-test-"))
      const venvBin = path.join(tmpDir, "venv", "bin")
      fs.mkdirSync(venvBin, { recursive: true })
      const pythonPath = path.join(venvBin, "python")
      fs.writeFileSync(pythonPath, "", { mode: 0o755 })

      mockPlatform("darwin")
      const result = findVenvPython(tmpDir)
      expect(result).toBe(pythonPath)

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true })
      restorePlatform()
    })

    test("returns null when no venv found", async () => {
      const { findVenvPython } = await import("../../src/util/python-resolver")
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-resolver-test-"))

      mockPlatform("darwin")
      const result = findVenvPython(tmpDir)
      expect(result).toBeNull()

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true })
      restorePlatform()
    })

    test("respects VIRTUAL_ENV environment variable", async () => {
      const { findVenvPython } = await import("../../src/util/python-resolver")
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-resolver-test-"))
      const venvBin = path.join(tmpDir, "bin")
      fs.mkdirSync(venvBin, { recursive: true })
      const pythonPath = path.join(venvBin, "python")
      fs.writeFileSync(pythonPath, "", { mode: 0o755 })

      // Set VIRTUAL_ENV
      const origVenv = process.env.VIRTUAL_ENV
      process.env.VIRTUAL_ENV = tmpDir

      mockPlatform("darwin")
      const result = findVenvPython("/some/other/project")
      expect(result).toBe(pythonPath)

      // Cleanup
      if (origVenv !== undefined) {
        process.env.VIRTUAL_ENV = origVenv
      } else {
        delete process.env.VIRTUAL_ENV
      }
      fs.rmSync(tmpDir, { recursive: true, force: true })
      restorePlatform()
    })
  })

  describe("getVenvPythonPaths", () => {
    test("returns Windows paths on win32", async () => {
      mockPlatform("win32")
      const { getVenvPythonPaths } = await import("../../src/util/python-resolver")
      const paths = getVenvPythonPaths("/project")
      expect(paths).toEqual([
        path.join("/project", ".venv", "Scripts", "python.exe"),
        path.join("/project", "venv", "Scripts", "python.exe"),
      ])
      restorePlatform()
    })

    test("returns Unix paths on darwin", async () => {
      mockPlatform("darwin")
      const { getVenvPythonPaths } = await import("../../src/util/python-resolver")
      const paths = getVenvPythonPaths("/project")
      expect(paths).toEqual([
        path.join("/project", ".venv", "bin", "python"),
        path.join("/project", "venv", "bin", "python"),
      ])
      restorePlatform()
    })
  })
})
