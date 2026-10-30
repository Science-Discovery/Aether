import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { MessageReferences } from "./message-references"
import { dict } from "@/i18n/en"
import type { QuoteReference } from "@/utils/conversation-quote-metadata"

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, values: Record<string, number> = {}) =>
      Object.entries(values).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), dict[key]),
  }),
}))

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

function mount(references: QuoteReference[], onSelect: (ref: QuoteReference) => void) {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(render(() => <MessageReferences references={references} onSelect={onSelect} />, host))
  return host
}

function conversation(): QuoteReference {
  return {
    kind: "conversation",
    quote: {
      kind: "conversation-quote",
      source: "assistant",
      action: "ask",
      sourceMessageID: "assistant",
      summary: "Earlier answer",
      fullText: "Full earlier answer",
      order: 2,
      question: "Explain the reasoning",
    },
  }
}

function pdf(): QuoteReference {
  return {
    kind: "pdf",
    quote: {
      mode: "quick",
      action: "ask",
      contentType: "text",
      pdfFileName: "paper.pdf",
      startPage: 2,
      endPage: 3,
      summary: "PDF passage",
      fullText: "Full PDF passage",
      order: 1,
      question: "Explain this passage",
    },
  }
}

describe("sent reference group", () => {
  test("groups mixed references without repeating questions and opens the matching complete reference", () => {
    const refs = [pdf(), conversation()]
    const select = vi.fn()
    const host = mount(refs, select)
    expect(host.querySelectorAll("section")).toHaveLength(1)
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("References · 2")
    const rows = host.querySelectorAll("button")
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain("Reference 1")
    expect(rows[0].textContent).toContain("paper.pdf")
    expect(rows[0].textContent).toContain("p.2-3")
    expect(rows[1].textContent).toContain("Reference 2")
    expect(rows[1].textContent).toContain("Earlier answer")
    expect(host.textContent).not.toContain("Explain")
    rows[0].click()
    rows[1].click()
    expect(select.mock.calls).toEqual([[refs[0]], [refs[1]]])
    expect(select.mock.calls[1][0].quote.question).toBe("Explain the reasoning")
  })

  test("keeps old references without questions or order readable, including translations", () => {
    const ref = pdf()
    if (ref.kind !== "pdf") throw new Error("Expected PDF")
    const legacy: QuoteReference = {
      ...ref,
      quote: { ...ref.quote, action: "translate", order: undefined, question: undefined },
    }
    const old = conversation()
    const host = mount([legacy, { ...old, quote: { ...old.quote, order: undefined, question: undefined } }], () => {})
    const rows = host.querySelectorAll("button")
    expect(rows[0].textContent).toContain("Reference 1")
    expect(rows[0].textContent).toContain("Translate")
    expect(rows[1].textContent).toContain("Reference 2")
    expect(host.textContent).not.toContain("undefined")
  })
})
