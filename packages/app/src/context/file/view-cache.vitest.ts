import { expect, test, vi } from "vitest"
import { checksum } from "@opencode-ai/util/encode"

vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))

import { createFileViewCache } from "./view-cache"

test("workspace drafts include closed files and pruning preserves only unsaved drafts", async () => {
  const cache = createFileViewCache()
  const view = cache.load(`/latex-cache-${crypto.randomUUID()}`, undefined)
  await view.ready.promise
  view.setDraft("closed.tex", "new text")
  view.setDraftBase("closed.tex", checksum("old text") ?? "")
  view.setDraft("unknown.bib", "unbased draft")
  view.setDraft("saved.tex", "saved text")
  view.setDraftBase("saved.tex", checksum("saved text") ?? "")
  for (let index = 0; index < 501; index++) view.setScrollTop(`file-${index}.txt`, index)
  expect(view.drafts().map((item) => item.path)).toEqual(["closed.tex", "unknown.bib"])
  expect(view.draftBase("closed.tex")).toBe(checksum("old text"))
  expect(view.draft("saved.tex")).toBeUndefined()
  expect(view.scrollTop("file-0.txt")).toBeUndefined()
  expect(view.scrollTop("file-500.txt")).toBe(500)
  cache.clear()
})

test("a captured draft view settles a save in its original workspace after cache eviction", async () => {
  const cache = createFileViewCache()
  const root = `/latex-settlement-${crypto.randomUUID()}`
  const original = cache.load(root, undefined)
  await original.ready.promise
  original.setDraft("main.tex", "saved snapshot")
  original.setDraftBase("main.tex", "old")
  for (let index = 0; index < 21; index++) cache.load(`${root}-${index}`, undefined)
  original.setDraft("main.tex", "new typing during save")
  original.setDraftBase("main.tex", checksum("saved snapshot") ?? "")
  const restored = cache.load(root, undefined)
  await restored.ready.promise
  expect(restored.draft("main.tex")).toBe("new typing during save")
  expect(restored.draftBase("main.tex")).toBe(checksum("saved snapshot"))
  expect(cache.load(`${root}-20`, undefined).draft("main.tex")).toBeUndefined()
  cache.clear()
})
