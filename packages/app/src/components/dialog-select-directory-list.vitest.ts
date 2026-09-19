import { expect, test } from "vitest"
import { createRoot } from "solid-js"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { sortRows, type Row } from "./dialog-select-directory-compare"

const folders = [
  "E:/paper/4_AI",
  "E:/paper/book",
  "E:/paper/tools",
  "E:/paper/.aether",
  "E:/paper/2026 pub",
  "E:/paper/Past years",
  "E:/paper/Unpublished",
]

const recent = ["E:/paper/5_Beyond perturbation/NonperturbativeDCT"]

const row = (absolute: string, group: Row["group"]): Row => ({
  absolute,
  search: `${absolute}\n${absolute}/`,
  group,
})

const expander: Row = {
  absolute: "__expander__",
  search: "",
  group: "recent",
  isExpander: true,
  expanderCount: 1,
}

const sortGroupsBy = (a: { category: string }, b: { category: string }) => {
  const order: Record<string, number> = { recent: 0, folders: 1 }
  return (order[a.category] ?? 2) - (order[b.category] ?? 2)
}

const setup = (items: (filter: string) => Promise<Row[]>) =>
  createRoot((dispose) => {
    const list = useFilteredList<Row>({
      items,
      key: (x) => x.absolute,
      filterKeys: ["search"],
      groupBy: (x) => x.group,
      sortBy: sortRows,
      sortGroupsBy,
    })
    return { list, dispose }
  })

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test("groups stay ordered and rows display alphabetically with expander last", async () => {
  const mounted = setup(async () => [
    ...recent.map((x) => row(x, "recent")),
    expander,
    ...[...folders].reverse().map((x) => row(x, "folders")),
  ])
  try {
    await flush()
    expect(mounted.list.flat().map((x) => x.absolute)).toEqual([
      "E:/paper/5_Beyond perturbation/NonperturbativeDCT",
      "__expander__",
      "E:/paper/.aether",
      "E:/paper/4_AI",
      "E:/paper/2026 pub",
      "E:/paper/book",
      "E:/paper/Past years",
      "E:/paper/tools",
      "E:/paper/Unpublished",
    ])
  } finally {
    mounted.dispose()
  }
})

test("fuzzysort filtering no longer scrambles display order", async () => {
  const mounted = setup(async () => [...folders].reverse().map((x) => row(x, "folders")))
  try {
    await flush()
    mounted.list.onInput("e:/paper/")
    await flush()
    expect(mounted.list.flat().map((x) => x.absolute)).toEqual([
      "E:/paper/.aether",
      "E:/paper/4_AI",
      "E:/paper/2026 pub",
      "E:/paper/book",
      "E:/paper/Past years",
      "E:/paper/tools",
      "E:/paper/Unpublished",
    ])
  } finally {
    mounted.dispose()
  }
})
