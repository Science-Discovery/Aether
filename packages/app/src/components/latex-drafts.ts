import { checksum } from "@opencode-ai/util/encode"

export type LatexDraft = { path: string; content: string; base?: string }

export function source(path: string) {
  return /\.(tex|bib|sty|cls|bst)$/i.test(path)
}

export function contains(root: string, path: string) {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
  const dir = normalize(root)
  const file = normalize(path)
  return !dir || dir === "." || file.startsWith(`${dir}/`)
}

export function dirty(draft: LatexDraft) {
  return draft.base === undefined || (checksum(draft.content) ?? "") !== draft.base
}

// Capture each save independently. Advancing the base to the captured bytes keeps
// edits made during the request dirty, including drafts whose tabs were closed.
export async function save(input: {
  root: string
  drafts: () => LatexDraft[]
  write: (draft: LatexDraft & { base: string }) => Promise<unknown>
  saved: (draft: LatexDraft, base: string) => void
}) {
  const drafts = input
    .drafts()
    .filter((draft) => source(draft.path) && contains(input.root, draft.path) && dirty(draft))
    .map((draft) => ({ ...draft }))
  const errors: { path: string; error: unknown }[] = []
  for (const draft of drafts) {
    if (draft.base === undefined) {
      errors.push({ path: draft.path, error: "missing-base" })
      continue
    }
    const result = await input.write({ ...draft, base: draft.base }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (!result.ok) {
      errors.push({ path: draft.path, error: result.error })
      continue
    }
    input.saved(draft, checksum(draft.content) ?? "")
  }
  return {
    errors,
    pending: input.drafts().filter((draft) => source(draft.path) && contains(input.root, draft.path) && dirty(draft)),
  }
}
