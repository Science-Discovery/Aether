import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"

const state = vi.hoisted(() => ({
  closed: 0,
  dialog: undefined as (() => JSX.Element) | undefined,
  health: true,
  intents: [] as Array<{ server: string; directory: string }>,
  measures: 0,
  routes: [] as string[],
  starts: 0,
  statusCalls: 0,
  updates: [] as Array<Record<string, unknown>>,
  config: {
    experimental: {
      attachment_text_extraction: {
        enabled: false,
        strategy: "local",
        mineru: {
          mode: "managed" as "managed" | "external",
          base_url: "http://127.0.0.1:8000",
          scope: "selective",
        },
      },
    },
  },
  managed: {
    supported: true,
    install: "unconfigured",
    run: "stopped",
    base_url: "http://127.0.0.1:8000",
  } as {
    supported: boolean
    install: string
    run: string
    base_url: string
    runtime?: "managed" | "adopted"
    version?: { uv?: string; python?: string; mineru: string }
    source?: "modelscope" | "huggingface" | "local"
    backend?: "pipeline"
    device?: string
    directory?: string
    data_directory?: string
    executable?: string
    size?: number
    size_scope?: "installation" | "aether_data" | "detected"
    scanned_at?: number
    storage?: {
      total: number
      environment: number
      models: number
      aether: number
      model_directories: string[]
    }
    session?: { id: string; directory: string }
  },
}))

vi.mock("@solidjs/router", () => ({ useNavigate: () => (route: string) => state.routes.push(route) }))
vi.mock("@opencode-ai/util/encode", () => ({ base64Encode: (value: string) => `b64(${value})` }))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown; disabled?: boolean; onClick?: () => void; "data-action"?: string }) => (
    <button data-action={props["data-action"]} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { title?: unknown; description?: unknown; children?: unknown }) => (
    <section data-testid="dialog">
      <h1>{props.title}</h1>
      <p>{props.description}</p>
      {props.children}
    </section>
  ),
}))

vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: {
    options: Array<{ value: "managed" | "external"; label: string }>
    onSelect?: (item: { value: "managed" | "external"; label: string }) => void
  }) => (
    <div data-testid="mode-select">
      {props.options.map((item) => (
        <button data-mode={item.value} onClick={() => props.onSelect?.(item)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}))

vi.mock("@opencode-ai/ui/switch", () => ({
  Switch: (props: { checked?: boolean; disabled?: boolean; onChange?: (value: boolean) => void }) => (
    <input
      data-testid="switch"
      type="checkbox"
      checked={props.checked}
      disabled={props.disabled}
      onChange={(event) => props.onChange?.(event.currentTarget.checked)}
    />
  ),
}))

vi.mock("@opencode-ai/ui/text-field", () => ({
  TextField: (props: { value?: string; onChange?: (value: string) => void; "data-action"?: string }) => (
    <input
      data-action={props["data-action"]}
      value={props.value}
      onInput={(event) => props.onChange?.(event.currentTarget.value)}
    />
  ),
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { "aria-label"?: string }) => <button aria-label={props["aria-label"]} />,
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Menu = (props: { children?: unknown }) => <div>{props.children}</div>
  return {
    DropdownMenu: Object.assign(Menu, {
      Trigger: (props: { "aria-label"?: string }) => <button aria-label={props["aria-label"]} />,
      Portal: Menu,
      Content: Menu,
      Item: (props: { children?: unknown; onSelect?: () => void }) => (
        <button onClick={props.onSelect}>{props.children}</button>
      ),
      ItemLabel: Menu,
      Separator: () => <hr />,
    }),
  }
})

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (view: () => JSX.Element) => {
      state.dialog = view
    },
    close: () => state.closed++,
  }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => {} }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/server", () => ({ useServer: () => ({ key: "local" }) }))
vi.mock("@/utils/open-intent", () => ({
  OpenIntent: {
    mark: (server: string, directory: string) => state.intents.push({ server, directory }),
  },
}))
vi.mock("@/utils/server-errors", () => ({ formatServerError: () => "error" }))
vi.mock("./dialog-mineru-setup", () => ({
  DialogMineruSetup: () => <div>setup-dialog</div>,
  DialogMineruRemove: () => <div>remove-dialog</div>,
  DialogMineruExternalHelp: () => <div>external-help</div>,
}))
vi.mock("./mineru-monitor", () => ({ watchMineruMonitor: () => {} }))
vi.mock("./settings-list", () => ({
  SettingsRow: (props: { title?: unknown; description?: unknown; children?: unknown }) => (
    <section data-testid="settings-row">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.children}
    </section>
  ),
}))

vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({
    data: { config: state.config },
    set: (_root: string, _key: string, value: typeof state.config.experimental) => {
      state.config.experimental = value
    },
    updateConfig: async (value: Record<string, unknown>) => {
      state.updates.push(value)
    },
  }),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    client: {
      global: {
        mineruManagedStatus: async () => {
          state.statusCalls++
          return { data: state.managed }
        },
        mineruHealth: async () => {
          if (!state.health) throw new Error("offline")
          return { data: { status: "healthy" } }
        },
        mineruManagedStart: async () => {
          state.starts++
          return { data: {} }
        },
        mineruManagedMeasure: async () => {
          state.measures++
          return { data: state.managed }
        },
      },
    },
  }),
}))

import { SettingsMineru } from "./settings-mineru"

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  return { host, off: render(() => <SettingsMineru />, host) }
}

function details() {
  const host = document.createElement("div")
  document.body.append(host)
  const view = state.dialog
  if (!view) throw new Error("MinerU settings dialog was not opened")
  return { host, off: render(view, host) }
}

beforeEach(() => {
  document.body.innerHTML = ""
  state.closed = 0
  state.dialog = undefined
  state.health = true
  state.intents = []
  state.measures = 0
  state.routes = []
  state.starts = 0
  state.statusCalls = 0
  state.updates = []
  state.config.experimental = {
    attachment_text_extraction: {
      enabled: false,
      strategy: "local",
      mineru: {
        mode: "managed",
        base_url: "http://127.0.0.1:8000",
        scope: "selective",
      },
    },
  }
  state.managed = {
    supported: true,
    install: "unconfigured",
    run: "stopped",
    base_url: "http://127.0.0.1:8000",
  }
})

describe("SettingsMineru", () => {
  test("does not query managed state or start a timer for the default external mode", async () => {
    state.config.experimental.attachment_text_extraction.mineru.mode = "external"
    const app = mount()
    await flush()

    expect(state.statusCalls).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.statusCalls).toBe(0)
    app.off()
  })

  test("renders one compact settings row and opens the service dialog", async () => {
    const app = mount()
    await flush()

    expect(app.host.querySelectorAll('[data-testid="settings-row"]')).toHaveLength(1)
    app.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-open"]')?.click()
    const modal = details()

    expect(modal.host.textContent).toContain("settings.general.row.mineruMode.title")
    expect(modal.host.textContent).toContain("settings.general.row.mineruScope.unsupported")
    expect(modal.host.textContent).toContain("settings.general.mineru.ai.configure")
    modal.off()
    app.off()
  })

  test("opens configuration without enabling an unconfigured managed service", async () => {
    const app = mount()
    await flush()

    app.host.querySelector<HTMLInputElement>('[data-testid="switch"]')?.click()
    await flush()

    expect(state.updates).toHaveLength(0)
    expect(state.dialog).toBeDefined()
    app.off()
  })

  test("keeps complete removal available after an interrupted setup", async () => {
    state.managed = {
      supported: true,
      install: "cancelled",
      run: "stopped",
      base_url: "http://127.0.0.1:8000",
    }
    const app = mount()
    await flush()

    app.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-open"]')?.click()
    const modal = details()
    expect(modal.host.querySelector('[data-action="settings-mineru-remove-incomplete"]')).not.toBeNull()
    expect(modal.host.textContent).toContain("settings.general.mineru.remove.open")
    modal.off()
    app.off()
  })

  test("enables a ready managed service without starting it", async () => {
    state.managed = {
      supported: true,
      install: "ready",
      run: "stopped",
      base_url: "http://127.0.0.1:8000",
      session: { id: "ses_setup", directory: "C:/project" },
    }
    const app = mount()
    await flush()

    app.host.querySelector<HTMLInputElement>('[data-testid="switch"]')?.click()
    await flush()

    expect(state.updates).toHaveLength(1)
    expect(state.config.experimental.attachment_text_extraction.enabled).toBe(true)
    expect(state.starts).toBe(0)

    app.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-open"]')?.click()
    const modal = details()
    expect(modal.host.textContent).toContain("settings.general.mineru.test")
    expect(modal.host.textContent).toContain("settings.general.mineru.ai.open")
    expect(modal.host.textContent).toContain("settings.general.mineru.ai.reconfigure")
    expect(modal.host.textContent).toContain("settings.general.mineru.remove.open")
    modal.off()
    app.off()
  })

  test("shows accurate details for an adopted environment", async () => {
    state.managed = {
      supported: true,
      install: "ready",
      run: "stopped",
      runtime: "adopted",
      base_url: "http://127.0.0.1:8000",
      directory: "C:/Users/Yan/mineru-env",
      data_directory: "C:/Users/Yan/.local/share/aether/mineru",
      executable: "C:/Users/Yan/mineru-env/Scripts/mineru-api.exe",
      version: { mineru: "3.4.4", python: "3.12.10", uv: "0.12.1" },
      source: "huggingface",
      backend: "pipeline",
      device: "auto",
      size: 4 * 1024 ** 3 + 77 * 1024,
      size_scope: "detected",
      scanned_at: 1_700_000_000_000,
      storage: {
        total: 4 * 1024 ** 3 + 77 * 1024,
        environment: 2.5 * 1024 ** 3,
        models: 1.5 * 1024 ** 3,
        aether: 77 * 1024,
        model_directories: ["C:/Users/Yan/.cache/huggingface"],
      },
    }
    const app = mount()
    await flush()

    app.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-open"]')?.click()
    const modal = details()

    expect(modal.host.textContent).toContain("settings.general.mineru.details.title")
    expect(modal.host.textContent).toContain("settings.general.mineru.details.runtime.adopted")
    expect(modal.host.textContent).toContain("C:/Users/Yan/mineru-env")
    expect(modal.host.textContent).toContain("C:/Users/Yan/.local/share/aether/mineru")
    expect(modal.host.textContent).toContain("3.4.4")
    expect(modal.host.textContent).toContain("3.12.10")
    expect(modal.host.textContent).toContain("0.12.1")
    expect(modal.host.textContent).toContain("Hugging Face")
    expect(modal.host.textContent).toContain("settings.general.mineru.details.device.auto")
    expect(modal.host.textContent).toContain("4.0 GiB")
    expect(modal.host.textContent).toContain("2.5 GiB")
    expect(modal.host.textContent).toContain("1.5 GiB")
    expect(modal.host.textContent).toContain("77 KiB")
    expect(modal.host.textContent).toContain("C:/Users/Yan/.cache/huggingface")
    expect(modal.host.textContent).toContain("settings.general.mineru.details.size.modelsShared")
    modal.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-measure"]')?.click()
    await flush()
    expect(state.measures).toBe(1)
    modal.off()
    app.off()
  })

  test("marks the original project before opening its configuration conversation", async () => {
    state.managed = {
      supported: true,
      install: "ready",
      run: "stopped",
      base_url: "http://127.0.0.1:8000",
      session: { id: "ses_setup", directory: "C:/setup-project" },
    }
    const app = mount()
    await flush()

    app.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-open"]')?.click()
    const modal = details()
    modal.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-chat"]')?.click()

    expect(state.intents).toEqual([{ server: "local", directory: "C:/setup-project" }])
    expect(state.routes).toEqual(["/b64(C:/setup-project)/session/ses_setup"])
    expect(state.closed).toBe(1)
    modal.off()
    app.off()
  })

  test("health-checks a custom service before enabling it", async () => {
    state.config.experimental.attachment_text_extraction.mineru.mode = "external"
    const app = mount()
    await flush()

    app.host.querySelector<HTMLInputElement>('[data-testid="switch"]')?.click()
    await flush()

    expect(state.config.experimental.attachment_text_extraction.enabled).toBe(true)
    expect(state.updates).toHaveLength(1)
    expect(state.dialog).toBeUndefined()
    app.off()
  })

  test("opens a concise setup guide for a custom service", async () => {
    state.config.experimental.attachment_text_extraction.mineru.mode = "external"
    const app = mount()
    await flush()

    app.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-open"]')?.click()
    const modal = details()
    expect(modal.host.querySelector('[data-action="settings-mineru-details"]')).toBeNull()
    const link = modal.host.querySelector<HTMLButtonElement>('[data-action="settings-mineru-external-help"]')
    expect(link?.className).toContain("underline")
    expect(link?.nextElementSibling?.textContent).toContain("settings.general.row.mineruMode.external")
    link?.click()
    const guide = details()

    expect(guide.host.textContent).toContain("external-help")
    guide.off()
    modal.off()
    app.off()
  })

  test("keeps a custom service disabled and opens details when the health check fails", async () => {
    state.config.experimental.attachment_text_extraction.mineru.mode = "external"
    state.health = false
    const app = mount()
    await flush()

    app.host.querySelector<HTMLInputElement>('[data-testid="switch"]')?.click()
    await flush()

    expect(state.config.experimental.attachment_text_extraction.enabled).toBe(false)
    expect(state.updates).toHaveLength(0)
    expect(state.dialog).toBeDefined()
    const modal = details()
    expect(modal.host.textContent).toContain("settings.general.row.mineruUrl.failed")
    modal.off()
    app.off()
  })
})
