import { afterEach, describe, expect, test } from "bun:test"
import { conversationRanges, conversationSelection } from "./conversation-selection"

afterEach(() => document.body.replaceChildren())

function fixture() {
  const root = document.createElement("div")
  root.dataset.messageId = "user-turn"
  root.innerHTML = `<div>User question</div>
    <div data-assistant-message-id="assistant-one" data-assistant-part-id="part-one"><span>repeat</span> <strong>repeat</strong></div>
    <div>Copy response and model information</div><div>Tool output</div>
    <div data-assistant-message-id="assistant-one" data-assistant-part-id="part-two">repeat</div>
    <div data-assistant-message-id="assistant-two" data-assistant-part-id="part-three">repeat</div>`
  document.body.append(root)
  const bodies = root.querySelectorAll<HTMLElement>("[data-assistant-part-id]")
  return { root, bodies }
}

function range(start: Node, end = start, offset = 0, length = end.textContent!.length) {
  const value = document.createRange()
  value.setStart(start, offset)
  value.setEnd(end, length)
  return value
}

describe("conversation selection source", () => {
  test("uses the actual assistant ID and distinguishes identical text at different DOM positions", () => {
    const view = fixture()
    const first = conversationSelection(view.root, range(view.bodies[0].querySelector("span")!.firstChild!))
    const second = conversationSelection(view.root, range(view.bodies[0].querySelector("strong")!.firstChild!))
    const later = conversationSelection(view.root, range(view.bodies[1].firstChild!))
    expect(first).toMatchObject({ messageID: "assistant-one", text: "repeat", start: 0, end: 6 })
    expect(second).toMatchObject({ messageID: "assistant-one", text: "repeat", start: 7, end: 13 })
    expect(later).toMatchObject({ messageID: "assistant-one", text: "repeat", start: 15, end: 21 })
    expect(conversationSelection(view.root, range(view.bodies[2].firstChild!))).toMatchObject({
      messageID: "assistant-two",
      start: 0,
    })
  })

  test("supports multiple text parts from one message without quoting controls or tool output", () => {
    const view = fixture()
    const value = conversationSelection(
      view.root,
      range(view.bodies[0].querySelector("strong")!.firstChild!, view.bodies[1].firstChild!),
    )
    expect(value).toMatchObject({ messageID: "assistant-one", start: 7, end: 21, text: "repeat\n\nrepeat" })
    expect(value?.containers).toHaveLength(2)
  })

  test("rejects cross-message and user-message selections instead of attributing them to the wrong source", () => {
    const view = fixture()
    expect(
      conversationSelection(view.root, range(view.bodies[1].firstChild!, view.bodies[2].firstChild!)),
    ).toBeUndefined()
    expect(conversationSelection(view.root, range(view.root.firstElementChild!.firstChild!))).toBeUndefined()
  })

  test("reconstructs exact text ranges across parts without including intervening controls", () => {
    const view = fixture()
    const source = conversationSelection(
      view.root,
      range(view.bodies[0].querySelector("strong")!.firstChild!, view.bodies[1].firstChild!),
    )!
    const ranges = conversationRanges(view.root, source)
    expect(ranges.map((item) => item.range.toString())).toEqual(["repeat", "repeat"])
    expect(ranges.map((item) => item.container.dataset.assistantPartId)).toEqual(["part-one", "part-two"])
    expect(ranges[0].range.endContainer.parentElement?.tagName).toBe("STRONG")
    expect(conversationRanges(view.root, { ...source, start: 0 })).toEqual([])
  })

  test("hides stale, collapsed and absent ranges, and restores them after the same source remounts", () => {
    const view = fixture()
    const source = conversationSelection(view.root, range(view.bodies[0].querySelector("strong")!.firstChild!))!
    view.bodies[0].querySelector("strong")!.textContent = "changed"
    expect(conversationRanges(view.root, source)).toEqual([])
    view.bodies[0].querySelector("strong")!.textContent = "repeat"
    view.root.dataset.assistantCollapsed = "true"
    expect(conversationRanges(view.root, source)).toEqual([])
    delete view.root.dataset.assistantCollapsed
    const position = view.bodies[0].nextSibling
    view.bodies[0].remove()
    expect(conversationRanges(view.root, source)).toEqual([])
    view.root.insertBefore(view.bodies[0], position)
    expect(conversationRanges(view.root, source)).toHaveLength(1)
    view.bodies[1].append(" streamed text")
    expect(conversationRanges(view.root, source)).toHaveLength(1)
  })
})
