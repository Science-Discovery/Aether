import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { parseAsync, renderDocument } from "docx-preview"
import { factory, source } from "./docx-dom"
import Docx from "./docx"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "zh" }) }))

// A small OOXML document containing Chinese text, a table and an external hyperlink.
const fixture =
  "UEsDBBQAAAAIAI9lX10rDTHOkAAAAO4AAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2PQQ6CQAxFr0Jma6DEhQsDbNQbeIFmLMzEYaah1eDtHZCVMS7b/1//b3N9MUkxjyFKa5wqHwHEOhpRqsQUs9KnaUTN4zQAo73jQLCv6wPYFJWilrrcMF1zph4fQYvLnNfiU2xNxk1x+viWqNYgc/AWNcuwqPCTmyjIH/AZb1/tyq1ZlcnVI86z7LYEWN/s3lBLAwQUAAAACACPZV9dYXsvQ4kAAADyAAAACwAAAF9yZWxzLy5yZWxzjc87DgIhEAbgqxAOsLNaWBigstnWeAECwyMujwwY9fZSWKzGwnLmn3x/Rpxx1T2W3EKsjT3Smpvkofd6BGgmYNJtKhXzSFyhpPsYyUPV5qo9wn6eD0BbgyuxNdliJafF7ji7PCv+YxfnosFTMbeEuf+o+LoYsiaPXfJ7IQv2vZ4Gy0EJ+HhRvQBQSwMEFAAAAAgAj2VfXRHfV5pKAQAAqwIAABEAAAB3b3JkL2RvY3VtZW50LnhtbI1SS07DMBC9iuUD4LSgUqI2EhTECgmJBet8JomFf7IH0nIBFqzhFogVEgdCiGPgxGlKEZXYzM9v3oyfPWviQue3EhSSpRTKxc2c1ogmZszlNcjU7WkDyp+V2soUfWor1mhbGKtzcI6rSgo2jqIJkylXtKex/6HRZclzOO0XCCQWRIpcK1dz42gya+JMF6vWm9bYzlx2LmPJjA0ZJtd+K2Is3HFoyMf7y+fzw+fb49frU4vCgO1sx4SZ6N255UUbVt4vtCBNK8L4IIoo21lmW50YNsi318RkAUKQ4z/GszV6R8/J7h4WxrHhBl1zvTJgBVc3xMa8mFNYIliVCvqD+ayvkQ6HHvJ7ysCykclBjkFgU13dBxFGo6NoQn1c+3gy3Z8GoUx1kVpfRW3m9HActQjLqxqHLNOIWg6pgLI/C4quZ7H1o7PN90y+AVBLAwQUAAAACACPZV9dDOany6QAAAAZAQAAHAAAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHON0MEKwjAMBuBXGb27iAcPsu2kBw9exBcIXbaWtWlp45hvb0EGEzx4DAnf/5PmTg7FBs7Gxlwt3nFulRGJJ4CsDXnMdYjEZTOE5FHKmEaIqCccCQ77/RHS1lBdszWra98qWoQSo1PV4xXpHz8Mg9V0DvrpieVHDJgiJWd5KiimkeTD5uLSgj46qi3P6GwPTDOl3UCizXp8C33pcVl7QdfA1ye6N1BLAQIUABQAAAAIAI9lX10rDTHOkAAAAO4AAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAj2VfXWF7L0OJAAAA8gAAAAsAAAAAAAAAAAAAAIABwQAAAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAgAj2VfXRHfV5pKAQAAqwIAABEAAAAAAAAAAAAAAIABcwEAAHdvcmQvZG9jdW1lbnQueG1sUEsBAhQAFAAAAAgAj2VfXQzmp8ukAAAAGQEAABwAAAAAAAAAAAAAAIAB7AIAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHNQSwUGAAAAAAQABAADAQAAygMAAAAA"
const data = () => Uint8Array.from(atob(fixture), (char) => char.charCodeAt(0)).buffer

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe("Word preview isolation", () => {
  test("renders the actual document into a separate document without active hyperlinks", async () => {
    const doc = document.implementation.createHTMLDocument("Word")
    const opts = { useBase64URL: true, renderAltChunks: false, h: factory(doc, () => true) }
    const model = await parseAsync(data(), opts)
    const nodes = await renderDocument(model, opts)
    doc.body.append(...nodes)
    expect(doc.body.textContent).toContain("Word preview 中文测试")
    expect(doc.body.textContent).toContain("Cell A")
    expect(doc.body.querySelectorAll("td")).toHaveLength(2)
    expect(doc.body.textContent).toContain("External link text")
    expect(doc.querySelector("a[href]")).toBeNull()
    expect(document.body.textContent).not.toContain("Word preview 中文测试")
    expect(nodes.every((node) => node.ownerDocument === doc)).toBe(true)
    expect(doc.querySelector("section.docx")).not.toBeNull()
  })

  test("the frame policy denies scripts, remote resources, embeds and form submissions", () => {
    const doc = new DOMParser().parseFromString(source, "text/html")
    const policy = doc.querySelector("meta[http-equiv]")?.getAttribute("content")
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("img-src data:")
    expect(policy).toContain("font-src data:")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(doc.querySelector("script")).toBeNull()
  })

  test("only creates passive elements and safe node properties", () => {
    const doc = document.implementation.createHTMLDocument("Word")
    const make = factory(doc, () => true)
    const node = make({
      tagName: "iframe",
      src: "https://example.invalid",
      onload: "alert(1)",
      children: ["plain text"],
    }) as Element
    expect(node.tagName).toBe("SPAN")
    expect(node.textContent).toBe("plain text")
    expect(node.getAttribute("src")).toBeNull()
    expect(node.getAttribute("onload")).toBeNull()
    expect(make({ tagName: "a", href: "javascript:alert(1)", children: ["link"] }).textContent).toBe("link")
    const cell = make({
      tagName: "td",
      colSpan: 2,
      style: { color: "red" },
      children: ["<script>text</script>"],
    }) as HTMLElement
    expect(cell.getAttribute("colspan")).toBe("2")
    expect(cell.style.color).toBe("red")
    expect(cell.querySelector("script")).toBeNull()
  })

  test("refuses further nodes after cancellation", () => {
    const make = factory(document, () => false)
    expect(() => make("late content")).toThrow("Preview cancelled")
  })
})

describe("Word preview lifecycle", () => {
  function mount(bytes = data()) {
    const host = document.createElement("div")
    document.body.append(host)
    const error = vi.fn()
    const off = render(() => <Docx data={bytes} path="docs/word.docx" onError={error} />, host)
    const frame = host.querySelector("iframe")!
    const doc = frame.contentDocument!
    return { host, frame, doc, error, off }
  }

  test("renders with frame-only styles and provides zoom controls", async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.host.querySelector('[aria-label="放大"]')?.hasAttribute("disabled")).toBe(false))
    expect(view.error).not.toHaveBeenCalled()
    expect(view.frame.getAttribute("sandbox")).toBe("allow-same-origin")
    expect(view.doc.body.textContent).toContain("Word preview 中文测试")
    expect(view.host.querySelector("section.docx")).toBeNull()
    expect(document.head.textContent).not.toContain("docx-wrapper")
    view.host.querySelector<HTMLButtonElement>('[aria-label="放大"]')!.click()
    expect(view.host.querySelector("[data-docx-scale]")?.textContent).toBe("120%")
    view.off()
    expect(view.doc.getElementById("document")?.childNodes.length ?? 0).toBe(0)
  })

  test("closing during parsing discards late success and errors", async () => {
    const view = mount(new ArrayBuffer(4))
    view.off()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(view.error).not.toHaveBeenCalled()
    expect(view.doc.getElementById("document")?.childNodes.length ?? 0).toBe(0)
  })

  test("reports malformed documents and supports cancel while loading", async () => {
    const view = mount(new ArrayBuffer(4))
    await vi.waitFor(() => expect(view.error).toHaveBeenCalledOnce())
    view.off()
    const next = mount()
    const cancel = Array.from(next.host.querySelectorAll("button")).find((button) => button.textContent === "取消")!
    cancel.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(next.error).toHaveBeenCalledOnce()
    expect(next.error.mock.calls[0]![0].message).toBe("已取消预览")
    next.off()
  })
})
