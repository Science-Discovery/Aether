import { describe, expect, test } from "bun:test"
import { all, panel, tab } from "./session-side-panel-state"

describe("session side panel desktop structure", () => {
  test("keeps desktop semantics when both panels are closed", () => {
    const result = panel({
      desktop: true,
      review_open: false,
      file_open: false,
      session_width: 480,
      tree_width: 320,
    })

    expect(result.review).toBe(false)
    expect(result.file).toBe(false)
    expect(result.open).toBe(false)
    expect(result.review_tab).toBe(true)
    expect(result.panel_width).toBe("0px")
    expect(result.tree_width).toBe("0px")
  })

  test("closes both panels on mobile", () => {
    const result = panel({
      desktop: false,
      review_open: true,
      file_open: true,
      session_width: 480,
      tree_width: 320,
    })

    expect(result.review).toBe(false)
    expect(result.file).toBe(false)
    expect(result.open).toBe(false)
    expect(result.review_tab).toBe(false)
    expect(result.panel_width).toBe("0px")
    expect(result.tree_width).toBe("0px")
  })

  test("uses layout state for desktop review-only mode", () => {
    const result = panel({
      desktop: true,
      review_open: true,
      file_open: false,
      session_width: 480,
      tree_width: 320,
    })

    expect(result.review).toBe(true)
    expect(result.file).toBe(false)
    expect(result.open).toBe(true)
    expect(result.review_tab).toBe(true)
    expect(result.panel_width).toBe("calc(100% - 480px)")
    expect(result.tree_width).toBe("0px")
  })

  test("uses layout state for desktop file-tree-only mode", () => {
    const result = panel({
      desktop: true,
      review_open: false,
      file_open: true,
      session_width: 480,
      tree_width: 320,
    })

    expect(result.review).toBe(false)
    expect(result.file).toBe(true)
    expect(result.open).toBe(true)
    expect(result.panel_width).toBe("320px")
    expect(result.tree_width).toBe("320px")
  })

  test("keeps dual-pane layout when both desktop panels are open", () => {
    const result = panel({
      desktop: true,
      review_open: true,
      file_open: true,
      session_width: 480,
      tree_width: 320,
    })

    expect(result.review).toBe(true)
    expect(result.file).toBe(true)
    expect(result.open).toBe(true)
    expect(result.panel_width).toBe("calc(100% - 480px)")
    expect(result.tree_width).toBe("320px")
  })

  test("prefers explicit overrides over layout state", () => {
    const result = panel({
      desktop: true,
      review_override: false,
      file_override: true,
      review_open: true,
      file_open: false,
      width_override: 640,
      tree_width_override: 280,
      session_width: 480,
      tree_width: 320,
    })

    expect(result.review).toBe(false)
    expect(result.file).toBe(true)
    expect(result.open).toBe(true)
    expect(result.panel_width).toBe("640px")
    expect(result.tree_width).toBe("280px")
  })
})

describe("session side panel file-tree tabs", () => {
  test("accepts only changes and all tabs", () => {
    expect(tab({ current: "changes", next: "all" })).toBe("all")
    expect(tab({ current: "all", next: "changes" })).toBe("changes")
    expect(tab({ current: "changes", next: "review" })).toBe("changes")
  })

  test("show-all action only changes the changes tab", () => {
    expect(all({ current: "changes" })).toBe("all")
    expect(all({ current: "all" })).toBe("all")
  })
})
