import { describe, expect, test } from "bun:test"
import { computeTabLabel } from "./tab-name"

describe("computeTabLabel", () => {
  test("returns filename when unique among tabs", () => {
    const result = computeTabLabel("src/components/Button.tsx", ["src/utils/helper.ts", "README.md"])
    expect(result).toBe("Button.tsx")
  })

  test("returns filename when it is the only tab", () => {
    const result = computeTabLabel("src/main.ts", [])
    expect(result).toBe("main.ts")
  })

  test("adds parent dir when filename collides", () => {
    const result = computeTabLabel("src/utils/helper.ts", ["src/hooks/helper.ts"])
    expect(result).toBe("utils/helper.ts")
  })

  test("adds more parent dirs if still ambiguous", () => {
    const result = computeTabLabel("a/src/utils/helper.ts", ["b/src/utils/helper.ts"])
    expect(result).toBe("a/src/utils/helper.ts")
  })

  test("handles root-level files without collision", () => {
    const result = computeTabLabel("README.md", ["package.json"])
    expect(result).toBe("README.md")
  })

  test("handles root-level files with collision", () => {
    const result = computeTabLabel("README.md", ["subdir/README.md"])
    expect(result).toBe("README.md")
  })

  test("handles subdir file colliding with root-level file", () => {
    const result = computeTabLabel("subdir/README.md", ["README.md"])
    expect(result).toBe("subdir/README.md")
  })

  test("handles three-way collision with different parents", () => {
    const result = computeTabLabel("src/utils/helper.ts", ["src/hooks/helper.ts", "lib/helper.ts"])
    expect(result).toBe("utils/helper.ts")
  })

  test("handles three-way collision where parent dirs also collide", () => {
    const result = computeTabLabel("a/src/helper.ts", ["b/src/helper.ts", "c/src/helper.ts"])
    expect(result).toBe("a/src/helper.ts")
  })

  test("handles Windows-style backslash paths", () => {
    const result = computeTabLabel("src\\utils\\helper.ts", ["src\\hooks\\helper.ts"])
    expect(result).toBe("utils/helper.ts")
  })

  test("handles trailing slashes", () => {
    const result = computeTabLabel("src/utils/helper.ts/", ["src/hooks/helper.ts"])
    expect(result).toBe("utils/helper.ts")
  })
})
