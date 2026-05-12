import { basename, isAbsolute, relative, sep } from "node:path"
import { Glob } from "../util/glob"

export namespace FileIgnore {
  const FOLDERS = new Set([
    "node_modules",
    "bower_components",
    ".pnpm-store",
    "vendor",
    ".npm",
    "dist",
    "build",
    "out",
    ".next",
    "target",
    "bin",
    "obj",
    ".git",
    ".svn",
    ".hg",
    ".vscode",
    ".idea",
    ".turbo",
    ".output",
    "desktop",
    ".sst",
    ".cache",
    ".webkit-cache",
    "__pycache__",
    ".pytest_cache",
    "mypy_cache",
    ".history",
    ".gradle",
  ])

  const FILES = [
    "**/*.swp",
    "**/*.swo",

    "**/*.pyc",

    // OS
    "**/.DS_Store",
    "**/Thumbs.db",

    // Logs & temp
    "**/logs/**",
    "**/tmp/**",
    "**/temp/**",
    "**/*.log",

    // Coverage/test outputs
    "**/coverage/**",
    "**/.nyc_output/**",
  ]

  export const PATTERNS = [...FILES, ...FOLDERS]
  export const WATCH = [`**/{${[...FOLDERS].join(",")}}`]

  export function filter(patterns: string[], file: string, root?: string) {
    const rel =
      root && isAbsolute(file)
        ? relative(root, file).split(sep).join("/")
        : file.split(sep).join("/")

    if (rel === "" || rel === "." || rel.startsWith("../")) return false

    for (const item of patterns) {
      if (item.includes("/")) {
        if (Glob.match(item, rel)) return true
        continue
      }
      if (Glob.match(item, basename(rel))) return true
    }

    return false
  }

  export function match(
    filepath: string,
    opts?: {
      extra?: string[]
      whitelist?: string[]
    },
  ) {
    for (const pattern of opts?.whitelist || []) {
      if (Glob.match(pattern, filepath)) return false
    }

    const parts = filepath.split(/[/\\]/)
    for (let i = 0; i < parts.length; i++) {
      if (FOLDERS.has(parts[i])) return true
    }

    const extra = opts?.extra || []
    for (const pattern of [...FILES, ...extra]) {
      if (Glob.match(pattern, filepath)) return true
    }

    return false
  }
}
