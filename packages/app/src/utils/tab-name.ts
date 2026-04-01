/**
 * Compute a shortened, unique tab label for a file path given the other open
 * file paths. The algorithm progressively adds parent directories until the
 * suffix is unique among all tabs.
 *
 * Examples:
 *   "src/utils/helper.ts" with ["src/hooks/helper.ts"] => "utils/helper.ts"
 *   "src/Button.tsx" with ["README.md"] => "Button.tsx"
 *   "a/src/helper.ts" with ["b/src/helper.ts"] => "a/src/helper.ts"
 */

const SEP_RE = /[\/\\]/

function splitPath(path: string): string[] {
  const trimmed = path.replace(/[\/\\]+$/, "")
  return trimmed.split(SEP_RE)
}

function getFilename(path: string): string {
  const parts = splitPath(path)
  return parts[parts.length - 1] ?? ""
}

export function computeTabLabel(path: string, otherPaths: string[]): string {
  const parts = splitPath(path)
  if (parts.length === 0) return path

  // Build suffixes for every other path (one segment from the right, then two, etc.)
  const otherSuffixes: string[][] = otherPaths.map((op) => splitPath(op))

  // Starting from the rightmost segment (filename), progressively add parent
  // segments until the suffix is unique.
  for (let len = 1; len <= parts.length; len++) {
    const suffix = parts.slice(-len)
    const suffixStr = suffix.join("/")

    // Check if any other path ends with the same suffix
    const collides = otherSuffixes.some((other) => {
      if (other.length < len) return false
      const otherSuffix = other.slice(-len)
      return otherSuffix.join("/") === suffixStr
    })

    if (!collides) {
      return suffixStr
    }
  }

  // Fallback: return the full normalized path
  return parts.join("/")
}
