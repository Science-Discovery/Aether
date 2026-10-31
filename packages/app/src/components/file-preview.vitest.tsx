import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"

const context = vi.hoisted(() => ({ fetch: vi.fn(), html: vi.fn() }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ fetch: context.fetch }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
vi.mock("@opencode-ai/ui/button", () => ({ Button: (props: Record<string, unknown>) => <button {...props} /> }))
vi.mock("./file-preview/docx", () => ({
  default: (props: { data: ArrayBuffer }) => <div data-docx>{new TextDecoder().decode(props.data)}</div>,
}))
vi.mock("./file-preview/xlsx", () => ({ default: () => <div data-xlsx /> }))
vi.mock("./file-preview/pptx", () => ({ default: () => <div data-pptx /> }))
vi.mock("./file-preview/html", () => ({
  default: (props: { source: string; onError: (err: Error) => void }) => {
    context.html(props.source)
    return (
      <button data-html onClick={() => props.onError(new Error("HTML parse failed"))}>
        {props.source}
      </button>
    )
  },
}))
import FilePreview from "./file-preview"

const pending = () => {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let host: HTMLDivElement
let dispose: () => void
const base = {
  path: "report.docx",
  src: "/file/raw?path=report.docx",
  version: 0,
  auth: "Basic fixture",
  read: async () => ({ data: new ArrayBuffer(0), mime: "text/css" }),
  draft: () => undefined,
  subscribe: () => () => {},
}
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  context.fetch.mockReset()
  context.html.mockClear()
})
afterEach(() => {
  dispose?.()
  host.remove()
})

describe("file preview loader", () => {
  test("reads authenticated bytes and mounts only its format", async () => {
    context.fetch.mockResolvedValue(new Response("docx content"))
    dispose = render(() => <FilePreview {...base} kind="docx" />, host)
    await vi.waitFor(() => expect(host.querySelector("[data-docx]")?.textContent).toBe("docx content"))
    expect(context.fetch).toHaveBeenCalledTimes(1)
    expect(context.fetch.mock.calls[0][1].headers).toEqual({ Authorization: "Basic fixture" })
    expect(host.querySelector("[data-xlsx],[data-pptx],[data-html]")).toBeNull()
  })
  test("aborts replaced reads and ignores their late results", async () => {
    const first = pending()
    context.fetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(new Response("fresh"))
    const [version, setVersion] = createSignal(0)
    dispose = render(() => <FilePreview {...base} version={version()} kind="docx" />, host)
    const signal = context.fetch.mock.calls[0][1].signal as AbortSignal
    setVersion(1)
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    await vi.waitFor(() => expect(host.querySelector("[data-docx]")?.textContent).toBe("fresh"))
    first.resolve(new Response("stale"))
    await Promise.resolve()
    await Promise.resolve()
    expect(host.querySelector("[data-docx]")?.textContent).toBe("fresh")
  })
  test("aborts on unmount and can retry failed reads", async () => {
    context.fetch.mockResolvedValueOnce(new Response("denied", { status: 401 }))
    const next = pending()
    context.fetch.mockReturnValueOnce(next.promise)
    dispose = render(() => <FilePreview {...base} kind="docx" />, host)
    await vi.waitFor(() => expect(host.textContent).toContain("HTTP 401"))
    host.querySelector("button")!.click()
    await vi.waitFor(() => expect(context.fetch).toHaveBeenCalledTimes(2))
    const signal = context.fetch.mock.calls[1][1].signal as AbortSignal
    dispose()
    expect(signal.aborted).toBe(true)
    next.resolve(new Response("late"))
  })
  test("HTML uses the current source without a binary read and retries after failure", async () => {
    dispose = render(() => <FilePreview {...base} kind="html" source="unsaved html" />, host)
    await vi.waitFor(() => expect(host.querySelector("[data-html]")).not.toBeNull())
    expect(context.fetch).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>("[data-html]")!.click()
    await vi.waitFor(() => expect(host.textContent).toContain("HTML parse failed"))
    host.querySelector("button")!.click()
    await vi.waitFor(() => expect(host.querySelector("[data-html]")?.textContent).toBe("unsaved html"))
    expect(context.html).toHaveBeenCalledTimes(2)
  })
})
