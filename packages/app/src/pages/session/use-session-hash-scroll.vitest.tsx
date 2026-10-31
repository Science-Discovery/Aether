import { afterEach, describe, expect, test, vi } from "vitest"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { render } from "solid-js/web"
import { Show } from "solid-js"
import { useSessionHashScroll } from "./use-session-hash-scroll"

const disposers: (() => void)[] = []

function mount(height: number) {
  const history = createMemoryHistory()
  history.set({ value: "/#target" })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const view = () => {
    let root: HTMLDivElement | undefined
    const control = useSessionHashScroll({
      sessionKey: () => "s1",
      sessionID: () => undefined,
      messagesReady: () => true,
      visibleUserMessages: () => [],
      historyMore: () => false,
      historyLoading: () => false,
      loadMore: async () => {},
      turnStart: () => 0,
      currentMessageId: () => undefined,
      pendingMessage: () => undefined,
      setPendingMessage: () => {},
      setActiveMessage: () => {},
      setTurnStart: () => {},
      autoScroll: { pause: () => {}, forceScrollToBottom: () => {} },
      scroller: () => root,
      anchor: (id) => `message-${id}`,
      scheduleScrollState: () => {},
      consumePendingMessage: () => undefined,
    })
    return (
      <div ref={root} data-root>
        <Show when={height > 0}>
          <div data-session-title />
        </Show>
        <div id="target" />
        <button onClick={() => control.applyHash("auto")}>Locate</button>
      </div>
    )
  }
  const dispose = render(
    () => (
      <MemoryRouter history={history}>
        <Route path="/" component={view} />
      </MemoryRouter>
    ),
    host,
  )
  disposers.push(() => {
    dispose()
    host.remove()
  })
  const root = host.querySelector<HTMLDivElement>("[data-root]")!
  const target = host.querySelector<HTMLDivElement>("#target")!
  const title = host.querySelector("[data-session-title]")
  if (title) Object.defineProperty(title, "offsetHeight", { value: height })
  root.scrollTop = 20
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 100 }))
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 300 }))
  return { root, target, locate: () => host.querySelector("button")!.click() }
}

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  vi.restoreAllMocks()
})

describe("message anchor spacing", () => {
  test("leaves eight pixels below the sticky session title", () => {
    const app = mount(46)
    app.locate()
    expect(app.root.scrollTop).toBe(166)
  })

  test("keeps the top gap without a session title", () => {
    const app = mount(0)
    app.locate()
    expect(app.root.scrollTop).toBe(212)
  })

  test("clamps the first message to the start of the scroll area", () => {
    const app = mount(45)
    vi.spyOn(app.target, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 110 }))
    app.locate()
    expect(app.root.scrollTop).toBe(0)
  })
})
