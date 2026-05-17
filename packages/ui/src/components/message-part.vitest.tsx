import { afterEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { render } from "solid-js/web"
import type { AssistantMessage, Part as SDKPart, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { DataProvider } from "../context/data"
import { I18nProvider } from "../context/i18n"
import { MarkedProvider } from "../context/marked"
import { dict as en } from "../i18n/en"
import { AssistantParts, assistantSource, Part } from "./message-part"

vi.mock("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/" }),
}))

const wait = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const i18n = {
  locale: () => "en",
  t: (key: keyof typeof en, params?: Record<string, string | number | boolean>) => {
    const text = en[key] ?? String(key)
    if (!params) return text
    return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, raw) => {
      const value = params[String(raw)]
      return value === undefined ? "" : String(value)
    })
  },
}

function msg(id: string, parentID = "u1"): AssistantMessage {
  return {
    id,
    sessionID: "s1",
    role: "assistant",
    time: {
      created: 1,
      completed: 1001,
    },
    parentID,
    modelID: "gpt-5",
    providerID: "openai",
    mode: "chat",
    agent: "build",
    path: {
      cwd: "/repo",
      root: "/repo",
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  }
}

function user(id: string): UserMessage {
  return {
    id,
    sessionID: "s1",
    role: "user",
    time: {
      created: 1,
    },
    path: {
      cwd: "/repo",
      root: "/repo",
    },
  }
}

function text(id: string, messageID: string, value: string, extra: Partial<TextPart> = {}): TextPart {
  return {
    id,
    sessionID: "s1",
    messageID,
    type: "text",
    text: value,
    ...extra,
  }
}

function shell(children: () => JSX.Element, parts: Record<string, SDKPart[]>) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <I18nProvider value={i18n}>
        <MarkedProvider>
          <DataProvider
            data={{
              provider: { all: [] },
              session: [],
              session_status: {},
              session_diff: {},
              message: {},
              part: parts,
            }}
            directory="/repo"
          >
            {children()}
          </DataProvider>
        </MarkedProvider>
      </I18nProvider>
    ),
    host,
  )
  return { host, off }
}

function mount(
  messages: AssistantMessage[],
  parts: Record<string, SDKPart[]>,
  extra: Partial<Parameters<typeof AssistantParts>[0]> = {},
) {
  return shell(
    () => (
      <AssistantParts
        messages={messages}
        showAssistantCopyPartID={extra.showAssistantCopyPartID}
        turnDurationMs={extra.turnDurationMs}
        working={extra.working}
        showReasoningSummaries={extra.showReasoningSummaries}
        shellToolDefaultOpen={extra.shellToolDefaultOpen}
        editToolDefaultOpen={extra.editToolDefaultOpen}
        onAssistantCollapse={extra.onAssistantCollapse}
        canCollapseAssistant={extra.canCollapseAssistant}
      />
    ),
    parts,
  )
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("assistant source view", () => {
  test("joins raw text parts in order", () => {
    expect(
      assistantSource([
        text("p1", "m1", "hello "),
        text("p2", "m1", "**world**"),
      ]),
    ).toBe("hello **world**")
  })

  test("toggles a rendered reply into raw source and back", async () => {
    const message = msg("m1")
    const raw = ["**bold**", "", "$$", "a+b", "$$"].join("\n")
    const { host, off } = mount([message], { [message.id]: [text("p1", message.id, raw)] }, { showAssistantCopyPartID: "p1" })

    await wait()

    expect(host.querySelector("strong")).toBeTruthy()
    expect(host.querySelector(".katex")).toBeTruthy()

    const code = host.querySelector('[data-slot="text-part-source-toggle"]')
    expect(code).toBeTruthy()
    code?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait()

    expect(host.querySelector('[data-slot="text-part-source"]')).toBeTruthy()
    expect(host.textContent).toContain("**bold**")
    expect(host.textContent).toContain("$$")
    expect(host.querySelector("strong")).toBeNull()
    expect(host.querySelector(".katex")).toBeNull()

    const next = host.querySelector('[data-slot="text-part-source-toggle"]')
    expect(next).toBeTruthy()
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait()

    expect(host.querySelector("strong")).toBeTruthy()
    expect(host.querySelector(".katex")).toBeTruthy()

    off()
  })

  test("shows the full source for replies split across assistant messages", async () => {
    const first = msg("m1")
    const second = msg("m2")
    const { host, off } = mount(
      [first, second],
      {
        [first.id]: [text("p1", first.id, "hello ")],
        [second.id]: [text("p2", second.id, "**world**")],
      },
      { showAssistantCopyPartID: "p2" },
    )

    await wait()

    const code = host.querySelector('[data-slot="text-part-source-toggle"]')
    expect(code).toBeTruthy()
    code?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait()

    expect(host.querySelector('[data-slot="text-part-source"]')?.textContent ?? "").toContain("hello **world**")

    off()
  })

  test("bypasses synthetic memory receipt formatting in source mode", async () => {
    const message = msg("m1")
    const raw = ["Memory updates:", "- [memory][write] Save note"].join("\n")
    const { host, off } = mount(
      [message],
      {
        [message.id]: [
          text("p1", message.id, raw, {
            synthetic: true,
            metadata: { memory_receipt: true },
          }),
        ],
      },
      { showAssistantCopyPartID: "p1" },
    )

    await wait()

    expect(host.textContent).not.toContain("[memory][write]")

    const code = host.querySelector('[data-slot="text-part-source-toggle"]')
    expect(code).toBeTruthy()
    code?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait()

    expect(host.textContent).toContain("[memory][write]")

    off()
  })

  test("keeps source mode scoped to the clicked assistant reply", async () => {
    const first = msg("m1")
    const second = msg("m2", "u2")
    const { host, off } = shell(
      () => (
        <>
          <div data-case="one">
            <AssistantParts messages={[first]} showAssistantCopyPartID="p1" />
          </div>
          <div data-case="two">
            <AssistantParts messages={[second]} showAssistantCopyPartID="p2" />
          </div>
        </>
      ),
      {
        [first.id]: [text("p1", first.id, "**one**")],
        [second.id]: [text("p2", second.id, "**two**")],
      },
    )

    await wait()

    const one = host.querySelector('[data-case="one"]') as HTMLElement
    const two = host.querySelector('[data-case="two"]') as HTMLElement
    const code = one.querySelector('[data-slot="text-part-source-toggle"]')
    expect(code).toBeTruthy()
    code?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait()

    expect(one.querySelector('[data-slot="text-part-source"]')?.textContent ?? "").toContain("**one**")
    expect(two.querySelector('[data-slot="text-part-source"]')).toBeNull()
    expect(two.querySelector("strong")).toBeTruthy()

    off()
  })

  test("does not show a source toggle for user messages", async () => {
    const message = user("u1")
    const part = text("p1", message.id, "**hello**")
    const { host, off } = shell(
      () => <Part part={part} message={message} />,
      {
        [message.id]: [part],
      },
    )

    await wait()

    expect(host.querySelector("strong")).toBeTruthy()
    expect(host.querySelector('[data-slot="text-part-source-toggle"]')).toBeNull()

    off()
  })

  test("keeps the collapse button to the left of the source toggle", async () => {
    const message = msg("m1")
    const { host, off } = mount(
      [message],
      {
        [message.id]: [text("p1", message.id, "**hello**")],
      },
      {
        showAssistantCopyPartID: "p1",
        canCollapseAssistant: true,
        onAssistantCollapse: () => {},
      },
    )

    await wait()

    const icons = Array.from(host.querySelectorAll('[data-slot="text-part-actions"] [data-component="icon-button"]')).map(
      (node) => node.getAttribute("data-icon"),
    )
    expect(icons).toEqual(["copy", "collapse", "code"])

    off()
  })
})
