import { describe, expect, test } from "bun:test"
import { compare } from "./dialog-select-directory-compare"

const sort = (rows: string[]) => [...rows].sort(compare)

describe("compare", () => {
  test("sorts directories naturally like a file explorer", () => {
    expect(
      sort([
        "E:/paper/4_AI",
        "E:/paper/book",
        "E:/paper/tools",
        "E:/paper/.aether",
        "E:/paper/2026 pub",
        "E:/paper/Past years",
        "E:/paper/Unpublished",
        "E:/paper/5_Beyond perturbation/NonperturbativeDCT",
      ]),
    ).toEqual([
      "E:/paper/.aether",
      "E:/paper/4_AI",
      "E:/paper/5_Beyond perturbation/NonperturbativeDCT",
      "E:/paper/2026 pub",
      "E:/paper/book",
      "E:/paper/Past years",
      "E:/paper/tools",
      "E:/paper/Unpublished",
    ])
  })

  test("treats digit runs as numbers", () => {
    expect(sort(["10_x", "9_x", "2_y"])).toEqual(["2_y", "9_x", "10_x"])
  })

  test("ignores case", () => {
    expect(sort(["Banana", "apple", "Cherry"])).toEqual(["apple", "Banana", "Cherry"])
  })

  test("keeps equal keys in place (stable)", () => {
    const rows = ["b/2", "a/2", "a/1"]
    expect([...rows].sort((x, y) => compare(x.slice(2), y.slice(2)))).toEqual(["a/1", "b/2", "a/2"])
  })

  test("is a valid comparator on tricky input", () => {
    const rows = ["~/a", "", "C:/", "//srv", "a b", "a  b", "Ä/ß", "z/1"]
    const sorted = sort(rows)
    for (let i = 1; i < sorted.length; i++) {
      expect(compare(sorted[i - 1], sorted[i])).toBeLessThanOrEqual(0)
    }
    expect([...sorted].sort(compare)).toEqual(sorted)
  })
})
