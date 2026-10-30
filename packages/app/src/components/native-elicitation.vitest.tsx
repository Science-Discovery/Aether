import { afterEach, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { NativeElicitation, NativeElicitationReceipt } from "@opencode-ai/sdk/v2"
import { Elicitation } from "./native-elicitation"

const mocks = vi.hoisted(() => ({ open: vi.fn(), reply: vi.fn() }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ openLink: mocks.open }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ url: "local", directory: "/project", client: { native: { replyElicitation: mocks.reply } } }),
}))
const cleanups: VoidFunction[] = []
const form = (): NativeElicitation => ({
  id: "request",
  sessionID: "session",
  threadID: "thread",
  server: "fixture",
  message: "Complete the form",
  expires: Date.now() + 1000,
  mode: "form",
  fields: [
    { name: "title", title: "Title", type: "string", required: true },
    { name: "count", title: "Count", type: "integer", required: true },
    { name: "enabled", title: "Enabled", type: "boolean", required: true, default: false },
    { name: "style", title: "Style", type: "string", required: false, options: [{ value: "short", title: "Short" }] },
    { name: "tags", title: "Tags", type: "array", required: false, options: [{ value: "math", title: "Mathematics" }] },
  ],
})

function mount(value = form(), send = vi.fn<NonNullable<Parameters<typeof Elicitation>[0]["send"]>>()) {
  const [request, set] = createSignal(value)
  const done = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <Elicitation request={request()} onDone={done} send={send} />, host)
  cleanups.push(() => {
    off()
    host.remove()
  })
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!
  const fill = (label: string, value: string) => {
    const input = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!
    input.value = value
    input.dispatchEvent(new window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }))
  }
  return { host, set, send, done, button, fill }
}

afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  vi.clearAllMocks()
})

test("submits selected options and typed scalars, disabling duplicate submission", async () => {
  const result = Promise.withResolvers<NativeElicitationReceipt>()
  const send = vi.fn<NonNullable<Parameters<typeof Elicitation>[0]["send"]>>(() => result.promise)
  const view = mount(form(), send)
  view.fill("Title", "Example")
  view.fill("Count", "3")
  view.fill("Style", "0")
  const check = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  check.checked = true
  check.dispatchEvent(new window.Event("change", { bubbles: true }))
  view.button("native.question.submit").click()
  expect(send).toHaveBeenCalledWith("accept", {
    title: "Example",
    count: 3,
    enabled: false,
    style: "short",
    tags: ["math"],
  })
  expect(view.host.querySelector("button")?.disabled).toBe(true)
  result.resolve({ id: "request", action: "accept" })
  await vi.waitFor(() => expect(view.done).toHaveBeenCalledOnce())
})

test("decline discards entered answers and late response cannot affect another session", async () => {
  const result = Promise.withResolvers<NativeElicitationReceipt>()
  const send = vi.fn<NonNullable<Parameters<typeof Elicitation>[0]["send"]>>(() => result.promise)
  const view = mount(form(), send)
  view.fill("Title", "private")
  view.button("native.elicitation.decline").click()
  expect(send).toHaveBeenCalledWith("decline", null)
  view.set({ ...form(), id: "next", sessionID: "another" })
  result.resolve({ id: "request", action: "decline" })
  await Promise.resolve()
  await Promise.resolve()
  expect(view.done).not.toHaveBeenCalled()
  expect(view.host.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.value).toBe("")
})

test("URL flow opens only on click, and opening does not imply acceptance", async () => {
  const value: NativeElicitation = {
    id: "url",
    sessionID: "session",
    threadID: "thread",
    server: "fixture",
    message: "Authorize",
    expires: Date.now() + 1000,
    mode: "url",
    url: "https://example.com/authorize?state=opaque",
  }
  const send = vi.fn<NonNullable<Parameters<typeof Elicitation>[0]["send"]>>(async (action) => ({ id: "url", action }))
  const view = mount(value, send)
  expect(mocks.open).not.toHaveBeenCalled()
  view.button("native.elicitation.open").click()
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledWith(value.url))
  expect(send).not.toHaveBeenCalled()
  view.button("native.elicitation.complete").click()
  expect(send).toHaveBeenCalledWith("accept", null)
  await vi.waitFor(() => expect(view.done).toHaveBeenCalledOnce())
})
