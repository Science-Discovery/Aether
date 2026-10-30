import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import type { Reference } from "@/utils/ask-reference"
import { ConversationMarks, placeConversationMarks } from "./conversation-marks"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (_: string, values: { number: number }) => `Reference ${values.number}` }),
}))

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function source(id = "first"): Reference {
  return {
    id,
    version: 1,
    kind: "conversation",
    messageID: "assistant",
    start: 0,
    end: 5,
    text: "alpha",
    summary: "alpha",
    question: "Explain",
  }
}

function pdf(): Reference {
  return {
    id: "pdf",
    version: 1,
    kind: "pdf",
    path: "paper.pdf",
    filename: "paper.pdf",
    mode: "quick",
    startPage: 1,
    endPage: 1,
    selection: "0:10",
    content: "text",
    question: "Explain",
    text: "PDF text",
    summary: "PDF text",
    settings: { questionPrompt: "" },
  }
}

function box(left: number, top: number, width: number, height: number) {
  return new DOMRect(left, top, width, height)
}

function mount(refs: Reference[] = [source()]) {
  const viewport = document.createElement("div")
  viewport.style.position = "relative"
  viewport.getBoundingClientRect = () => box(0, 0, 400, 300)
  const root = document.createElement("div")
  root.innerHTML = `<div data-assistant-message-id="assistant" data-assistant-part-id="first">alpha beta</div>
    <div>Unrelated tool output</div><div data-assistant-message-id="assistant" data-assistant-part-id="second">gamma delta</div>`
  const layer = document.createElement("div")
  viewport.append(root, layer)
  document.body.append(viewport)
  const bodies = root.querySelectorAll<HTMLElement>("[data-assistant-part-id]")
  const position = { top: 80, left: 20 }
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const body = this.startContainer.parentElement!.closest<HTMLElement>("[data-assistant-part-id]")!
    const prefix = this.cloneRange()
    prefix.selectNodeContents(body)
    prefix.setEnd(this.startContainer, this.startOffset)
    const top = position.top + (body === bodies[1] ? 40 : 0)
    const rect = box(position.left + prefix.toString().length * 6, top, this.toString().length * 6, 18)
    return [rect] as unknown as DOMRectList
  })
  const [state, set] = createStore<{ references: Reference[]; editing?: Reference }>({ references: refs })
  const select = vi.fn()
  cleanups.push(
    render(
      () => (
        <ConversationMarks
          root={() => root}
          viewport={() => viewport}
          references={state.references}
          editing={state.editing}
          onSelect={select}
        />
      ),
      layer,
    ),
  )
  return {
    root,
    layer,
    bodies,
    position,
    set,
    select,
    marks: () => [...layer.querySelectorAll<HTMLButtonElement>('[data-component="conversation-reference-mark"]')],
    highlights: () => layer.querySelectorAll('[data-component="conversation-reference-highlight"]'),
  }
}

describe("temporary conversation reference marks", () => {
  test("uses mixed-reference numbers, highlights the selected text and edits the corresponding reference", async () => {
    const ref = source()
    const view = mount([pdf(), ref])
    const content = view.root.innerHTML
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    const button = view.marks()[0]
    expect(button.textContent).toBe("2")
    expect(button.getAttribute("aria-label")).toBe("Reference 2")
    button.dispatchEvent(new MouseEvent("mouseenter"))
    expect(view.highlights()).toHaveLength(1)
    expect((view.highlights()[0] as HTMLElement).style.width).toBe("30px")
    button.click()
    expect(view.select.mock.calls[0][0]).toMatchObject({ id: ref.id, text: "alpha", question: "Explain" })
    button.dispatchEvent(new MouseEvent("mouseleave"))
    expect(view.highlights()).toHaveLength(0)
    view.set("references", [ref])
    await vi.waitFor(() => expect(view.marks()[0].textContent).toBe("1"))
    expect(view.marks()[0]).toBe(button)
    expect(view.root.innerHTML).toBe(content)
    view.set("references", [])
    await vi.waitFor(() => expect(view.marks()).toHaveLength(0))
  })

  test("preserves keyboard focus while repositioning and clears highlights when its reference disappears", async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    const button = view.marks()[0]
    button.focus()
    expect(view.highlights()).toHaveLength(1)
    const top = button.style.top
    view.position.top += 30
    window.dispatchEvent(new Event("scroll"))
    await vi.waitFor(() => expect(button.style.top).not.toBe(top))
    expect(view.marks()[0]).toBe(button)
    expect(document.activeElement).toBe(button)
    view.set("references", [])
    await vi.waitFor(() => expect(view.marks()).toHaveLength(0))
    expect(view.highlights()).toHaveLength(0)
  })

  test("keeps a new editor selection highlighted across parts without creating a number before save", async () => {
    const view = mount([])
    const first = source()
    if (first.kind !== "conversation") throw new Error("Expected conversation")
    const ref = { ...first, start: 6, end: 17, text: "beta\n\ngamma" }
    view.set("editing", ref)
    await vi.waitFor(() => expect(view.highlights()).toHaveLength(2))
    expect(view.marks()).toHaveLength(0)
    view.set("editing", undefined)
    await vi.waitFor(() => expect(view.highlights()).toHaveLength(0))
    view.set("references", [ref])
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    view.set("editing", ref)
    await vi.waitFor(() => expect(view.highlights()).toHaveLength(2))
    view.set("editing", undefined)
    await vi.waitFor(() => expect(view.highlights()).toHaveLength(0))
    expect(view.marks()).toHaveLength(1)
  })

  test("removes stale or hidden marks and restores exact source ranges after remounting", async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    view.root.dataset.assistantCollapsed = "true"
    await vi.waitFor(() => expect(view.marks()).toHaveLength(0))
    delete view.root.dataset.assistantCollapsed
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    view.bodies[0].textContent = "omega beta"
    await vi.waitFor(() => expect(view.marks()).toHaveLength(0))
    view.bodies[0].textContent = "alpha beta with streamed text"
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    const sibling = view.bodies[0].nextSibling
    view.bodies[0].remove()
    await vi.waitFor(() => expect(view.marks()).toHaveLength(0))
    view.root.insertBefore(view.bodies[0], sibling)
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    view.position.top = 400
    window.dispatchEvent(new Event("resize"))
    await vi.waitFor(() => expect(view.marks()).toHaveLength(0))
  })

  test.each(["pre", "table"])("clips selected text to its nested %s scroller", async (tag) => {
    const view = mount()
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    view.bodies[0].innerHTML =
      tag === "pre"
        ? "<pre><span>alpha</span> beta</pre>"
        : "<table><tbody><tr><td><span>alpha</span> beta</td></tr></tbody></table>"
    const scroller = view.bodies[0].firstElementChild as HTMLElement
    scroller.style.overflowX = "auto"
    scroller.getBoundingClientRect = () => box(30, 70, 70, 40)
    view.set("editing", source())
    await vi.waitFor(() => expect(view.highlights()).toHaveLength(1))
    expect((view.highlights()[0] as HTMLElement).style.left).toBe("30px")
    expect((view.highlights()[0] as HTMLElement).style.width).toBe("20px")
    expect(view.marks()).toHaveLength(1)

    // The range remains inside the timeline, but horizontal scrolling clips it out of the code/table box.
    view.position.left = -10
    scroller.dispatchEvent(new Event("scroll"))
    await vi.waitFor(() => expect(view.marks()).toHaveLength(0))
    expect(view.highlights()).toHaveLength(0)

    view.position.left = 40
    scroller.dispatchEvent(new Event("scroll"))
    await vi.waitFor(() => expect(view.marks()).toHaveLength(1))
    expect((view.highlights()[0] as HTMLElement).style.left).toBe("40px")
    expect((view.highlights()[0] as HTMLElement).style.width).toBe("30px")
  })

  test("separates adjacent endpoint badges and keeps them within the viewport", () => {
    const bounds = { left: 0, top: 0, right: 180, bottom: 120 }
    const anchors = Array.from({ length: 5 }, () => ({ left: 155, top: 8, right: 179, bottom: 26, width: 20 }))
    const placed = placeConversationMarks(anchors, bounds)
    expect(placed.every(Boolean)).toBe(true)
    placed.forEach((box, index) => {
      expect(box!.left).toBeGreaterThanOrEqual(4)
      expect(box!.top).toBeGreaterThanOrEqual(4)
      expect(box!.right).toBeLessThanOrEqual(bounds.right - 4)
      expect(box!.bottom).toBeLessThanOrEqual(bounds.bottom - 4)
      placed.slice(index + 1).forEach((other) => {
        expect(
          box!.right <= other!.left ||
            box!.left >= other!.right ||
            box!.bottom <= other!.top ||
            box!.top >= other!.bottom,
        ).toBe(true)
      })
    })
  })
})
