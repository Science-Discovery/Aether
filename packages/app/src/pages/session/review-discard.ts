import type { FileDiff } from "@opencode-ai/sdk/v2"

export type DiscardAction = {
  /** What to do to discard the file change */
  action: "write" | "delete" | "none"
  /** Content to write back (for "write" action) */
  content?: string
  /** Remaining diffs after removing the discarded file */
  remaining: FileDiff[]
}

/**
 * Determines what operations to perform to discard a single file change
 * from a list of diffs. Returns the action type, content to restore,
 * and the remaining diffs with the target file removed.
 *
 * - "modified" files: write back the `before` content
 * - "added" files (empty `before`): delete the file
 * - "deleted" files (empty `after`): write back the `before` content
 */
export function discardFileDiff(diffs: FileDiff[], filePath: string): DiscardAction {
  const idx = diffs.findIndex((d) => d.file === filePath)
  if (idx === -1) {
    return { action: "none", remaining: diffs }
  }

  const diff = diffs[idx]
  const remaining = [...diffs.slice(0, idx), ...diffs.slice(idx + 1)]

  const isAdded = diff.status === "added" || (diff.before === "" && diff.after.length > 0)

  if (isAdded) {
    return { action: "delete", remaining }
  }

  return {
    action: "write",
    content: diff.before,
    remaining,
  }
}
