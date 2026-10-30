import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeMcpAuthStatus, NativeMcpStatus } from "@opencode-ai/sdk/v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { formatServerError } from "@/utils/server-errors"

export function NativeMcp(props: { sessionID?: string } = {}) {
  const sdk = useSDK()
  const language = useLanguage()
  const platform = usePlatform()
  const [state, setState] = createStore<{
    data?: NativeMcpStatus
    busy: boolean
    error?: string
    login?: NativeMcpAuthStatus
    recovering: boolean
    cancelling: boolean
  }>({ busy: false, recovering: false, cancelling: false })
  type Attempt = { id: string; name: string; scope: string; client: typeof sdk.client; reading?: boolean }
  let current: Attempt | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let disposed = false
  const key = () => `${sdk.url}\n${sdk.directory}\n${props.sessionID ?? ""}`
  const active = () => state.login?.state === "starting" || state.login?.state === "pending"
  const valid = (attempt: Attempt) => !disposed && current === attempt && attempt.scope === key()
  const message = (err: unknown) =>
    formatServerError(
      typeof err === "object" && err !== null && "error" in err && typeof err.error === "string" ? err.error : err,
      language.t,
    )
  const auth = (value: string) => {
    if (value === "unsupported") return language.t("native.mcp.auth.unsupported")
    if (value === "bearerToken") return language.t("native.mcp.auth.token")
    if (value === "oAuth") return language.t("native.mcp.auth.oauth")
    if (value === "notLoggedIn") return language.t("native.mcp.auth.required")
    if (value === "unknown") return language.t("native.mcp.auth.unknown")
    return value
  }
  async function refresh(force = false) {
    const scope = key()
    const stamp = ++revision
    setState({ busy: true, error: undefined, data: undefined })
    await sdk.client.native
      .mcp({ refresh: force, sessionID: props.sessionID }, { throwOnError: true })
      .then((result) => {
        if (disposed || stamp !== revision || scope !== key()) return
        if (!result.data) throw new Error(language.t("native.question.noResult"))
        setState({ data: result.data, error: result.data.error })
      })
      .catch((err: unknown) => {
        if (!disposed && stamp === revision && scope === key()) setState("error", message(err))
      })
      .finally(() => {
        if (!disposed && stamp === revision && scope === key()) setState("busy", false)
      })
  }

  function detach() {
    clearTimeout(timer)
    const attempt = current
    current = undefined
    if (attempt)
      void attempt.client.native
        .cancelMcpLogin({ id: attempt.id }, { signal: AbortSignal.timeout(10_000) })
        .catch(() => undefined)
  }
  createEffect(
    on(key, () => {
      detach()
      setState({ login: undefined, recovering: false, cancelling: false })
      void refresh()
    }),
  )
  onCleanup(() => {
    disposed = true
    revision++
    detach()
  })

  async function accept(attempt: Attempt, status?: NativeMcpAuthStatus) {
    if (!valid(attempt)) return
    if (!status || status.id !== attempt.id || (status.name && status.name !== attempt.name))
      throw new Error(language.t("native.mcp.login.invalid"))
    setState({ login: status, error: status.state === "complete" ? undefined : status.error, recovering: false })
    clearTimeout(timer)
    if (status.state === "starting" || status.state === "pending") {
      timer = setTimeout(() => void poll(attempt), 2_000)
      return
    }
    current = undefined
    setState("cancelling", false)
    if (status.state === "complete") await refresh(true)
  }

  async function poll(attempt: Attempt) {
    if (!valid(attempt) || attempt.reading || state.cancelling) return
    attempt.reading = true
    clearTimeout(timer)
    await attempt.client.native
      .mcpLoginStatus({ id: attempt.id }, { signal: AbortSignal.timeout(10_000), throwOnError: false })
      .then(async (response) => {
        if (!valid(attempt) || state.cancelling) return
        if (response.response?.status === 404) {
          // GET can overtake a delayed POST after a lost response. Establish a
          // cancellation tombstone before allowing a fresh authorization UUID.
          const cancelled = await attempt.client.native.cancelMcpLogin(
            { id: attempt.id },
            { signal: AbortSignal.timeout(10_000) },
          )
          return accept(attempt, cancelled.data)
        }
        if (response.error) throw response.error
        return accept(attempt, response.data)
      })
      .catch((err: unknown) => {
        // Retain the UUID after a lost response; another OAuth start could
        // otherwise create a second authorization flow.
        if (valid(attempt)) setState({ recovering: true, error: message(err) })
      })
      .finally(() => {
        attempt.reading = false
      })
  }

  async function start(name: string) {
    if (current || state.busy) return
    const attempt: Attempt = { id: crypto.randomUUID(), name, scope: key(), client: sdk.client }
    current = attempt
    setState({ login: { id: attempt.id, name, state: "starting" }, recovering: false, error: undefined })
    await attempt.client.native
      .mcpLogin({ id: attempt.id, name }, { signal: AbortSignal.timeout(15_000), throwOnError: false })
      .then(async (response) => {
        if (!valid(attempt)) {
          await attempt.client.native
            .cancelMcpLogin({ id: attempt.id }, { signal: AbortSignal.timeout(10_000) })
            .catch(() => undefined)
          return
        }
        const code = response.response?.status
        if (code && code >= 400 && code < 500) {
          current = undefined
          setState({ login: undefined, error: message(response.error) })
          return
        }
        if (response.error) throw response.error
        return accept(attempt, response.data)
      })
      .catch(() => poll(attempt))
  }

  async function cancel() {
    const attempt = current
    if (!attempt || state.cancelling) return
    clearTimeout(timer)
    setState("cancelling", true)
    await attempt.client.native
      .cancelMcpLogin({ id: attempt.id }, { signal: AbortSignal.timeout(10_000) })
      .then((response) => accept(attempt, response.data))
      .catch((err: unknown) => {
        if (valid(attempt)) setState({ recovering: true, error: message(err) })
      })
      .finally(() => {
        if (!disposed && attempt.scope === key()) setState("cancelling", false)
      })
  }

  async function open() {
    const value = state.login?.url
    if (!active() || !value) return
    const scope = key()
    await Promise.resolve()
      .then(() => {
        if (disposed || key() !== scope) return
        const address = new URL(value)
        if (!["http:", "https:"].includes(address.protocol) || address.username || address.password)
          throw new Error(language.t("native.mcp.login.invalid"))
        return platform.openLink(address.href)
      })
      .catch((err: unknown) => {
        if (!disposed && key() === scope) setState("error", message(err))
      })
  }

  return (
    <Dialog title={language.t("native.slash.mcp")}>
      <div class="p-4 flex flex-col gap-3 overflow-y-auto max-h-[70vh]">
        <p class="text-12-regular text-text-weak">
          {language.t(state.data?.scope === "session" ? "native.mcp.session" : "native.mcp.description")}
        </p>
        <Button size="small" variant="secondary" disabled={state.busy || active()} onClick={() => void refresh(true)}>
          {language.t(state.busy ? "common.loading" : "native.mcp.refresh")}
        </Button>
        <Show when={state.login}>
          {(login) => (
            <section
              class="rounded-md border border-border-base p-3 flex flex-col gap-2"
              data-component="native-mcp-login"
            >
              <strong>{login().name}</strong>
              <p role="status" class="text-12-regular">
                {language.t(state.recovering ? "native.mcp.login.recovering" : `native.mcp.login.${login().state}`)}
              </p>
              <Show when={login().state === "complete" && login().error}>
                {(error) => (
                  <p role="alert" class="text-12-regular break-words">
                    {error()}
                  </p>
                )}
              </Show>
              <Show when={active()}>
                <p class="text-12-regular text-text-weak">{language.t("native.mcp.login.description")}</p>
                <div class="flex flex-wrap gap-2">
                  <Show when={login().url}>
                    <Button size="small" disabled={state.cancelling} onClick={() => void open()} data-action="mcp-open">
                      {language.t("native.mcp.login.open")}
                    </Button>
                  </Show>
                  <Show when={state.recovering}>
                    <Button
                      size="small"
                      disabled={state.cancelling}
                      onClick={() => current && void poll(current)}
                      data-action="mcp-check"
                    >
                      {language.t("native.mcp.login.check")}
                    </Button>
                  </Show>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={state.cancelling}
                    onClick={() => void cancel()}
                    data-action="mcp-cancel"
                  >
                    {language.t("common.cancel")}
                  </Button>
                </div>
              </Show>
            </section>
          )}
        </Show>
        <Show when={state.error}>
          {(error) => (
            <div role="alert" class="break-words">
              {error()}
            </div>
          )}
        </Show>
        <Show when={!state.busy && !state.error && !state.data?.servers.length}>
          <div>{language.t(state.data?.state === "disabled" ? "native.disabledShort" : "native.mcp.empty")}</div>
        </Show>
        <For each={state.data?.servers}>
          {(server) => (
            <section class="rounded-md border border-border-base p-3 flex flex-col gap-2">
              <strong>{server.name}</strong>
              <div class="text-12-regular text-text-weak">
                {language.t("native.mcp.connection")}:{" "}
                {server.status === "unknown" ? language.t("native.mcp.unknown") : server.status} ·{" "}
                {language.t("native.mcp.auth")}: {auth(server.auth)}
              </div>
              <Show when={server.auth === "notLoggedIn" || server.auth === "oAuth"}>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={active() || state.busy}
                  onClick={() => void start(server.name)}
                  data-action="mcp-login"
                >
                  {language.t(server.auth === "oAuth" ? "native.mcp.login.again" : "native.mcp.login.start")}
                </Button>
              </Show>
              <Show when={server.error}>
                {(error) => (
                  <div role="alert" class="break-words">
                    {error()}
                  </div>
                )}
              </Show>
              <For each={server.tools}>
                {(tool) => (
                  <div class="text-12-regular">
                    <span class="font-medium">{tool.name}</span>
                    <p class="text-text-weak whitespace-pre-wrap">{tool.description}</p>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  )
}
