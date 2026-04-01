/**
 * Python resolver: cross-platform Python detection with virtual environment support.
 *
 * On Windows, uses `python` (or `python.exe`) directly instead of relying on bash.
 * On Unix, prefers `python3` with fallback to `python`.
 * Detects and uses virtual environments (.venv, venv, VIRTUAL_ENV) when available.
 */

import path from "path"
import { existsSync } from "fs"

/**
 * Returns the preferred Python command name for the current platform.
 * - Windows: "python"
 * - Unix: "python3"
 */
export function resolvePythonCommand(): string {
  return process.platform === "win32" ? "python" : "python3"
}

/**
 * Returns an ordered list of Python command candidates to probe.
 * On Windows, skips Unix-only absolute paths.
 * On Unix, includes common absolute paths as fallbacks.
 */
export function getPythonCandidates(): string[] {
  const primary = resolvePythonCommand()
  const candidates: string[] = []

  if (process.platform === "win32") {
    // On Windows: try "python", then "py" launcher
    candidates.push("python", "py")
  } else {
    // On Unix: try python3 first, then python, then common absolute paths
    candidates.push("python3", "python", "/usr/bin/python3", "/usr/local/bin/python3")
  }

  // Deduplicate in case primary is already in the list
  return [...new Set(candidates)]
}

/**
 * Returns the platform-specific Python binary path inside a virtual environment.
 * - Windows: `.venv/Scripts/python.exe`
 * - Unix: `.venv/bin/python`
 */
export function getVenvPythonPaths(projectDir: string): string[] {
  const isWindows = process.platform === "win32"
  const pythonRelPath = isWindows
    ? path.join("Scripts", "python.exe")
    : path.join("bin", "python")

  return [
    path.join(projectDir, ".venv", pythonRelPath),
    path.join(projectDir, "venv", pythonRelPath),
  ]
}

/**
 * Searches for a Python interpreter inside a virtual environment.
 *
 * Checks in order:
 * 1. VIRTUAL_ENV environment variable
 * 2. .venv/ in the project directory
 * 3. venv/ in the project directory
 *
 * Returns the absolute path to the Python binary if found, null otherwise.
 */
export function findVenvPython(projectDir: string): string | null {
  const isWindows = process.platform === "win32"
  const pythonRelPath = isWindows
    ? path.join("Scripts", "python.exe")
    : path.join("bin", "python")

  // Check VIRTUAL_ENV environment variable first
  const virtualEnv = process.env.VIRTUAL_ENV
  if (virtualEnv) {
    const venvPython = path.join(virtualEnv, pythonRelPath)
    if (existsSync(venvPython)) {
      return venvPython
    }
  }

  // Check .venv/ and venv/ in the project directory
  const venvPaths = getVenvPythonPaths(projectDir)
  for (const venvPython of venvPaths) {
    if (existsSync(venvPython)) {
      return venvPython
    }
  }

  return null
}

/**
 * Returns all Python candidate paths in priority order:
 * 1. Virtual environment Python (if detected)
 * 2. Platform-appropriate command names and absolute paths
 */
export function getAllPythonCandidates(projectDir?: string): string[] {
  const candidates: string[] = []

  // Check for venv Python first (highest priority)
  if (projectDir) {
    const venvPython = findVenvPython(projectDir)
    if (venvPython) {
      candidates.push(venvPython)
    }
  }

  // Add platform-specific candidates
  candidates.push(...getPythonCandidates())

  return candidates
}
