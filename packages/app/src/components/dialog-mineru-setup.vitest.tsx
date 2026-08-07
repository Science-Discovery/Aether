import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"

const state = vi.hoisted(() => ({
  closed: 0,
  created: [] as Array<{ title: string }>,
  linked: [] as Array<{ id: string; directory: string }>,
  prompts: [] as Array<Record<string, unknown>>,
  routes: [] as string[],
  removed: [] as boolean[],
  statusCalls: 0,
  notifications: [] as Array<[string, string]>,
  plan: {
    runtime: "managed" as "managed" | "adopted",
    owned: { path: "C:/aether/mineru", size: 4 * 1024 ** 3 },
    environment: undefined as { path: string; size?: number } | undefined,
    models: [] as Array<{ path: string; size?: number }>,
    config: undefined as string | undefined,
    removable: 4 * 1024 ** 3,
  },
  dir: "encoded",
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { title?: string; children?: unknown; class?: string; fit?: boolean }) => (
    <section class={props.class} data-fit={props.fit ? "true" : undefined}>
      <h1>{props.title}</h1>
      {props.children}
    </section>
  ),
}))

vi.mock("@opencode-ai/ui/checkbox", () => ({
  Checkbox: (props: {
    children?: unknown
    checked?: boolean
    onChange?: (value: boolean) => void
    description?: string
    "data-action"?: string
  }) => (
    <label>
      <input
        type="checkbox"
        data-action={props["data-action"]}
        checked={props.checked}
        onChange={(event) => props.onChange?.(event.currentTarget.checked)}
      />
      {props.children}
      <span>{props.description}</span>
    </label>
  ),
}))

vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: { options: Array<{ label: string }> }) => (
    <div data-testid="models">{props.options.map((item) => item.label).join("|")}</div>
  ),
}))

vi.mock("@opencode-ai/ui/text-field", () => ({
  TextField: (props: { label?: string; value?: string; "data-action"?: string }) => (
    <label>
      {props.label}
      <textarea data-action={props["data-action"]} value={props.value} readOnly />
    </label>
  ),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ close: () => state.closed++ }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => {} }))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => (route: string) => state.routes.push(route),
  useParams: () => ({
    get dir() {
      return state.dir
    },
  }),
}))

vi.mock("@opencode-ai/util/encode", () => ({ base64Encode: (value: string) => `b64(${value})` }))
vi.mock("@/utils/base64", () => ({ decode64: (value: string | undefined) => (value ? "C:/project" : undefined) }))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    createClient: () => ({
      session: {
        create: async (input: { title: string }) => {
          state.created.push(input)
          return { data: { id: "ses_mineru" } }
        },
        promptAsync: async (input: Record<string, unknown>) => {
          state.prompts.push(input)
          return { data: {} }
        },
      },
    }),
    client: {
      global: {
        mineruManagedSession: async (input: { id: string; directory: string }) => {
          state.linked.push(input)
          return { data: {} }
        },
        mineruManagedStatus: async () => {
          state.statusCalls++
          return { data: { supported: true, install: "unconfigured" } }
        },
        mineruManagedUninstall: async () => ({ data: state.plan }),
        mineruManagedRemove: async (input: { adopted?: boolean }) => {
          state.removed.push(input.adopted === true)
          return { data: {} }
        },
      },
    },
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => (key.endsWith(".prompt") ? "Please call $configure-mineru after inspection." : key),
  }),
}))

vi.mock("@/context/models", () => ({
  useModels: () => ({
    list: () => [
      { id: "plain", name: "Plain", capabilities: { toolcall: false }, provider: { id: "p", name: "Provider" } },
      { id: "hidden", name: "Hidden", capabilities: { toolcall: true }, provider: { id: "p", name: "Provider" } },
      { id: "tool", name: "Tool", capabilities: { toolcall: true }, provider: { id: "p", name: "Provider" } },
    ],
    visible: (input: { modelID: string }) => input.modelID !== "hidden",
    recent: { list: () => [{ providerID: "p", modelID: "tool" }] },
  }),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({ notify: async (title: string, description: string) => state.notifications.push([title, description]) }),
}))
vi.mock("@/utils/server-errors", () => ({ formatServerError: () => "error" }))

import {
  confirmMineruStart,
  DialogMineruExternalHelp,
  DialogMineruRemove,
  DialogMineruSetup,
} from "./dialog-mineru-setup"
import { MineruMonitor, watchMineruMonitor } from "./mineru-monitor"

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ""
  localStorage.clear()
  state.closed = 0
  state.created = []
  state.linked = []
  state.prompts = []
  state.routes = []
  state.removed = []
  state.statusCalls = 0
  state.notifications = []
  state.plan = {
    runtime: "managed",
    owned: { path: "C:/aether/mineru", size: 4 * 1024 ** 3 },
    environment: undefined,
    models: [],
    config: undefined,
    removable: 4 * 1024 ** 3,
  }
  state.dir = "encoded"
})

describe("DialogMineruSetup", () => {
  test("does not check managed state while idle and only monitors after an explicit request", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(() => <MineruMonitor />, host)
    await flush()

    expect(state.statusCalls).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.statusCalls).toBe(0)

    watchMineruMonitor()
    await flush()
    expect(state.statusCalls).toBe(1)
    watchMineruMonitor(false)
    off()
  })

  test("shows concise custom service installation, startup, and connection instructions", () => {
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(() => <DialogMineruExternalHelp />, host)

    expect(host.querySelector("section")?.className).toContain("780px")
    expect(host.textContent).toContain("settings.general.mineru.externalHelp.check.title")
    expect(host.textContent).toContain("settings.general.mineru.externalHelp.python.title")
    expect(host.textContent).toContain("settings.general.mineru.externalHelp.env.title")
    expect(host.textContent).toContain("settings.general.mineru.externalHelp.uv.title")
    expect(host.textContent).toContain("settings.general.mineru.externalHelp.install.title")
    expect(host.textContent).toContain("settings.general.mineru.externalHelp.start.title")
    expect(host.textContent).toContain("settings.general.mineru.externalHelp.connect.title")
    const values = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].map((item) => item.value)
    expect(values).toHaveLength(7)
    expect(values[0]).toBe("py --list")
    expect(values[1]).toBe("winget install --id Python.Python.3.12 --exact")
    expect(values[2]).toContain("-m venv")
    expect(values[3]).toContain("pip install -U pip uv")
    expect(values[4]).toContain('mineru[all]')
    expect(values[4]).not.toContain("==3.4.4")
    expect(values[5]).toContain("mineru-api.exe")
    expect(values[5]).toContain("--host 127.0.0.1 --port 8000")
    expect(values[6]).toBe("http://127.0.0.1:8000")
    off()
  })

  test("shows privacy details and starts a tool-capable setup conversation", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(() => <DialogMineruSetup />, host)

    expect(host.textContent).toContain("settings.general.mineru.ai.privacy")
    expect(host.querySelector('[data-testid="models"]')?.textContent).toBe("Provider / Hidden|Provider / Tool")

    const start = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "settings.general.mineru.ai.start",
    )
    expect(start).toBeDefined()
    start?.click()
    await flush()

    expect(state.created).toEqual([{ title: "settings.general.mineru.ai.sessionTitle" }])
    expect(state.linked).toEqual([{ id: "ses_mineru", directory: "C:/project" }])
    expect(state.routes).toEqual(["/b64(C:/project)/session/ses_mineru"])
    expect(state.closed).toBe(1)
    expect(state.prompts).toEqual([
      {
        sessionID: "ses_mineru",
        model: { providerID: "p", modelID: "tool" },
        parts: [{ type: "text", text: "Please call $configure-mineru after inspection." }],
      },
    ])
    off()
  })

  test("requires a current project without reading the project SDK context", () => {
    state.dir = ""
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(() => <DialogMineruSetup />, host)

    expect(host.textContent).toContain("settings.general.mineru.ai.noProject")
    expect(
      [...host.querySelectorAll("button")].find((item) => item.textContent === "settings.general.mineru.ai.start")
        ?.disabled,
    ).toBe(true)
    off()
  })

  test("uses a compact fit layout for the attachment start confirmation", async () => {
    let view: (() => JSX.Element) | undefined
    const result = confirmMineruStart({
      show: (render: () => JSX.Element) => {
        view = render
      },
    } as Parameters<typeof confirmMineruStart>[0])
    if (!view) throw new Error("MinerU start dialog was not opened")

    const host = document.createElement("div")
    document.body.append(host)
    const off = render(view, host)
    const modal = host.querySelector("section")

    expect(modal?.getAttribute("data-fit")).toBe("true")
    expect(modal?.className).toContain("560px")
    expect(host.querySelector('[data-action="mineru-start-dialog"]')?.className).not.toContain("max-w-md")

    const decline = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "settings.general.mineru.start.decline",
    )
    decline?.click()
    await expect(result).resolves.toBe(false)
    expect(state.closed).toBe(1)
    off()
  })

  test("shows the managed installation and removes all Aether-owned files", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(() => <DialogMineruRemove done={() => {}} />, host)
    await flush()

    expect(host.textContent).toContain("settings.general.mineru.remove.managed")
    expect(host.textContent).toContain("C:/aether/mineru")
    expect(host.textContent).toContain("4.0 GiB")
    const confirm = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "settings.general.mineru.remove.confirm",
    )
    confirm?.click()
    await flush()

    expect(state.removed).toEqual([false])
    expect(state.closed).toBe(1)
    off()
  })

  test("keeps an adopted environment unless the user explicitly selects it", async () => {
    state.plan = {
      runtime: "adopted",
      owned: { path: "C:/aether/mineru", size: 100 },
      environment: { path: "C:/Users/Yan/mineru-env", size: 2 * 1024 ** 3 },
      models: [{ path: "C:/Users/Yan/.cache/modelscope/models/OpenDataLab--PDF-Extract-Kit-1.0" }],
      config: "C:/Users/Yan/mineru.json",
      removable: 4 * 1024 ** 3,
    }
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(() => <DialogMineruRemove done={() => {}} />, host)
    await flush()

    expect(host.textContent).toContain("settings.general.mineru.remove.adopted")
    expect(host.textContent).not.toContain("C:/Users/Yan/mineru-env")
    expect(host.textContent).toContain("settings.general.mineru.remove.disconnect")
    expect(host.textContent).toContain("100 B")
    expect(host.textContent).not.toContain("4.0 GiB")
    const check = host.querySelector<HTMLInputElement>('[data-action="settings-mineru-remove-adopted"]')
    check?.click()
    await flush()

    expect(host.textContent).toContain("C:/Users/Yan/mineru-env")
    expect(host.textContent).toContain("OpenDataLab--PDF-Extract-Kit-1.0")
    expect(host.textContent).toContain("C:/Users/Yan/mineru.json")
    expect(host.textContent).toContain("4.0 GiB")
    const confirm = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "settings.general.mineru.remove.confirm",
    )
    confirm?.click()
    await flush()
    expect(state.removed).toEqual([true])
    off()
  })
})
