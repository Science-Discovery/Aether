import { afterEach, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/util/encode"
import { NativeForkSource } from "./native-fork-source"

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock("@/context/sync", () => ({ useSync: () => ({ session: { get: mocks.get } }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string, args?: { title: string }) => args?.title ?? key }),
}))
vi.mock("@solidjs/router", () => ({ A: (props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }))
const cleanups: VoidFunction[] = []
afterEach(() => {
  cleanups.splice(0).forEach((off) => off())
  mocks.get.mockReset()
})
const session: Session = {
  id: "fork",
  directory: "/project",
  slug: "fork",
  projectID: "project",
  title: "Fork",
  version: "1",
  time: { created: 1, updated: 1 },
  engine: { type: "codex" },
  forkParentSessionID: "source",
}
function mount(value: Session) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <NativeForkSource session={value} />, host)
  cleanups.push(() => {
    off()
    host.remove()
  })
  return host
}
test("links to the immediate source using its cached directory and title", () => {
  mocks.get.mockReturnValue({ directory: "/source", title: "Original proof" })
  const host = mount(session)
  expect(host.querySelector("a")?.getAttribute("href")).toBe(`/${base64Encode("/source")}/session/source`)
  expect(host.textContent).toBe("Original proof")
})
test("uses a generic source label when the source is not cached", () => {
  const host = mount(session)
  expect(host.querySelector("a")?.getAttribute("href")).toBe(`/${base64Encode("/project")}/session/source`)
  expect(host.textContent).toBe("native.fork.original")
})
test("does not label native subagents or Aether forks as native forks", () => {
  expect(mount({ ...session, forkParentSessionID: undefined, parentID: "source" }).querySelector("a")).toBeNull()
  expect(mount({ ...session, engine: undefined }).querySelector("a")).toBeNull()
})
