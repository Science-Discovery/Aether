import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"
import { NativeImage } from "./native-image"

const mocks = vi.hoisted(() => ({ image: vi.fn(), show: vi.fn(), directory: () => "/project" }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "server",
    get directory() {
      return mocks.directory()
    },
    client: { native: { image: mocks.image } },
  }),
}))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: mocks.show }) }))

const message = { id: "msg_image", sessionID: "ses_image", role: "assistant" } as AssistantMessage
const part = (): ToolPart => ({
  id: "prt_image",
  messageID: message.id,
  sessionID: message.sessionID,
  type: "tool",
  callID: "image",
  tool: "codex.imageView",
  state: {
    status: "completed",
    input: { path: "/project/image.png" },
    output: "",
    title: "imageView",
    metadata: {},
    time: { start: 1, end: 2 },
  },
})
const cleanups: VoidFunction[] = []
function mount(value = part()) {
  const [state, setState] = createStore({ part: value })
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <NativeImage part={state.part} message={message} />, host)
  cleanups.push(() => {
    off()
    host.remove()
  })
  return { host, update: (value: ToolPart) => setState("part", value) }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.directory = () => "/project"
})
afterEach(() => cleanups.splice(0).forEach((off) => off()))

test("completed native images render and open the zoom preview", async () => {
  mocks.image.mockResolvedValue({ data: { url: "data:image/png;base64,AAAA", name: "image.png" } })
  const view = mount()
  await vi.waitFor(() => expect(view.host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA"))
  expect(mocks.image).toHaveBeenCalledWith({ sessionID: "ses_image", messageID: "msg_image", partID: "prt_image" })
  view.host.querySelector("button")?.click()
  expect(mocks.show).toHaveBeenCalledOnce()
})

test("running tools wait for completion and unrelated tools do not fetch images", async () => {
  mocks.image.mockResolvedValue({ data: { url: "data:image/png;base64,AAAA", name: "image.png" } })
  const value = part()
  const view = mount({ ...value, state: { status: "running", input: {}, time: { start: 1 } } })
  expect(mocks.image).not.toHaveBeenCalled()
  view.update({ ...value, tool: "bash" })
  expect(mocks.image).not.toHaveBeenCalled()
  view.update({ ...value, tool: "codex.imageGeneration" })
  await vi.waitFor(() => expect(view.host.querySelector("img")).not.toBeNull())
})

test("late image responses from the previous project cannot appear in the new project", async () => {
  const pending = Promise.withResolvers<{ data: { url: string; name: string } }>()
  mocks.image
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ data: { url: "data:image/png;base64,NEW", name: "new.png" } })
  const [scope, setScope] = createStore({ directory: "/project" })
  mocks.directory = () => scope.directory
  const view = mount()
  setScope("directory", "/other")
  await vi.waitFor(() => expect(view.host.querySelector("img")?.getAttribute("alt")).toBe("new.png"))
  pending.resolve({ data: { url: "data:image/png;base64,OLD", name: "old.png" } })
  await pending.promise
  expect(view.host.querySelector("img")?.getAttribute("alt")).toBe("new.png")
})

test("failed images provide retry without breaking the conversation", async () => {
  mocks.image
    .mockRejectedValueOnce(new Error("Missing image"))
    .mockResolvedValue({ data: { url: "data:image/png;base64,AAAA", name: "image.png" } })
  const view = mount()
  await vi.waitFor(() => expect(view.host.textContent).toContain("native.image.unavailable"))
  expect(view.host.querySelector("img")).toBeNull()
  view.host.querySelector("button")?.click()
  await vi.waitFor(() => expect(view.host.querySelector("img")).not.toBeNull())
})
