import { afterEach, describe, expect, test, vi } from "vitest"
import { onMount, type Component } from "solid-js"
import { render } from "solid-js/web"
import { FileComponentProvider } from "../context/file"
import { SessionReview } from "./session-review"
import type { FileDiff } from "@opencode-ai/sdk/v2"

type DiffProps = {
  diffStyle?: "unified" | "split"
  before?: { contents?: string }
  after?: { contents?: string }
  onRendered?: () => void
}

const Stub: Component<DiffProps> = (props) => {
  onMount(() => props.onRendered?.())
  return (
    <div
      data-component="diff-stub"
      data-style={props.diffStyle}
      data-before={props.before?.contents ?? ""}
      data-after={props.after?.contents ?? ""}
    />
  )
}

const diff = (input: Partial<FileDiff> & Pick<FileDiff, "file">): FileDiff => ({
  file: input.file,
  additions: input.additions ?? 0,
  deletions: input.deletions ?? 0,
  before: input.before ?? "",
  after: input.after ?? "",
  status: input.status ?? "modified",
})

const mount = (diffs: FileDiff[], extra?: Partial<Parameters<typeof SessionReview>[0]>) => {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <FileComponentProvider component={Stub}>
        <SessionReview diffs={diffs} {...extra} />
      </FileComponentProvider>
    ),
    host,
  )
  return { host, off }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("session review", () => {
  test("renders added, removed, and media-modified labels with the expected semantics", () => {
    const { host, off } = mount(
      [
        diff({ file: "add.ts", status: "added", before: "", after: "new\n", additions: 1 }),
        diff({ file: "gone.ts", status: "deleted", before: "old\n", after: "", deletions: 1 }),
        diff({
          file: "photo.png",
          status: "modified",
          before: new Uint8Array([1]),
          after: new Uint8Array([2]),
        }),
      ],
      {
        open: ["add.ts", "gone.ts", "photo.png"],
      },
    )

    expect(host.querySelector('[data-slot="session-review-change"][data-type="added"]')?.textContent).toContain("Added")
    expect(host.querySelector('[data-slot="session-review-change"][data-type="removed"]')?.textContent).toContain(
      "Removed",
    )
    expect(host.querySelector('[data-slot="session-review-change"][data-type="modified"]')?.textContent).toContain(
      "Modified",
    )
    expect(host.textContent).toContain("+1")
    expect(host.textContent).not.toContain("+0-0")

    off()
  })

  test("guards large diffs until render anyway is clicked", async () => {
    const { host, off } = mount(
      [
        diff({
          file: "big.ts",
          status: "modified",
          before: "a\n",
          after: "b\n",
          additions: 501,
          deletions: 0,
        }),
      ],
      {
        open: ["big.ts"],
      },
    )

    expect(host.textContent).toContain("Diff too large to render")
    expect(host.querySelector('[data-component="diff-stub"]')).toBeNull()

    const btn = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Render anyway"))
    expect(btn).toBeTruthy()
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    await Promise.resolve()

    expect(host.querySelector('[data-component="diff-stub"]')).toBeTruthy()

    off()
  })

  test("view-file click calls onViewFile without toggling accordion state", () => {
    const view = vi.fn()
    const open = vi.fn()
    const { host, off } = mount([diff({ file: "note.ts", additions: 1, after: "x\n" })], {
      open: [],
      onOpenChange: open,
      onViewFile: view,
    })

    const btn = host.querySelector('[data-slot="session-review-view-button"]')
    expect(btn).toBeTruthy()
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    expect(view).toHaveBeenCalledWith("note.ts")
    expect(open).not.toHaveBeenCalled()

    off()
  })

  test("expand-all toggles open state for every diff", async () => {
    const { host, off } = mount([
      diff({ file: "a.ts", additions: 1, after: "a\n" }),
      diff({ file: "b.ts", additions: 1, after: "b\n" }),
    ])

    const btn = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Expand all"))
    expect(btn).toBeTruthy()
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    await Promise.resolve()

    expect(host.textContent).toContain("Collapse all")
    expect(host.querySelectorAll('[data-component="diff-stub"]')).toHaveLength(2)

    const next = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("Collapse all"))
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    await Promise.resolve()

    expect(host.textContent).toContain("Expand all")

    off()
  })
})
