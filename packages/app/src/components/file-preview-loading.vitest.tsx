import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Suspense } from "solid-js"
import { render } from "solid-js/web"

const context = vi.hoisted(() => {
  const gate = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve, requested: false }
  }
  return { fetch: vi.fn(), docx: gate(), xlsx: gate(), pptx: gate(), html: gate() }
})
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ fetch: context.fetch }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
vi.mock("@opencode-ai/ui/button", () => ({ Button: (props: Record<string, unknown>) => <button {...props} /> }))
vi.mock("./file-preview/docx", async () => {
  context.docx.requested = true
  await context.docx.promise
  return { default: () => <div data-format="docx" /> }
})
vi.mock("./file-preview/xlsx", async () => {
  context.xlsx.requested = true
  await context.xlsx.promise
  return { default: () => <div data-format="xlsx" /> }
})
vi.mock("./file-preview/pptx", async () => {
  context.pptx.requested = true
  await context.pptx.promise
  return { default: () => <div data-format="pptx" /> }
})
vi.mock("./file-preview/html", async () => {
  context.html.requested = true
  await context.html.promise
  return { default: () => <div data-format="html" /> }
})
import FilePreview from "./file-preview"

let host: HTMLDivElement
let dispose: () => void
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  context.fetch.mockImplementation(async () => new Response("fixture"))
})
afterEach(() => {
  dispose?.()
  host.remove()
})

describe("local document loading boundary", () => {
  test.each(["docx", "xlsx", "pptx", "html"] as const)(
    "keeps the surrounding shell mounted during a cold %s import",
    async (kind) => {
      dispose = render(
        () => (
          <Suspense fallback={<div data-global-loading />}>
            <div data-shell>
              <header>Conversation and tabs</header>
              <FilePreview
                kind={kind}
                path={`sample.${kind}`}
                src="/file/raw"
                version={0}
                source="<p>hello</p>"
                read={async () => ({ data: new ArrayBuffer(0), mime: "text/css" })}
                draft={() => undefined}
                subscribe={() => () => {}}
              />
              <footer>Message input</footer>
            </div>
          </Suspense>
        ),
        host,
      )
      const shell = host.querySelector("[data-shell]")
      await vi.waitFor(() => expect(context[kind].requested).toBe(true))
      expect(host.querySelector("[data-shell]")).toBe(shell)
      expect(host.querySelector("header")?.textContent).toBe("Conversation and tabs")
      expect(host.querySelector("footer")?.textContent).toBe("Message input")
      expect(host.querySelector("[data-global-loading]")).toBeNull()
      expect(host.querySelector('[data-component="file-preview"] [role="status"]')).not.toBeNull()
      context[kind].resolve()
      await vi.waitFor(() => expect(host.querySelector(`[data-format="${kind}"]`)).not.toBeNull())
      expect(host.querySelector("[data-shell]")).toBe(shell)
    },
  )
})
