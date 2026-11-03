import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeAuthStatus } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import type { GlobalSDKValue } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { refreshNativeStatus } from "@/context/native-status"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { formatServerError } from "@/utils/server-errors"

export function NativeLogin(props: {
  client: ReturnType<GlobalSDKValue["createClient"]>
  scope: string
  server: string
  disabled?: boolean
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const [store, setStore] = createStore<{
    status?: NativeAuthStatus
    active: boolean
    checking: boolean
    cancelling: boolean
    recovering: boolean
    copied: boolean
    error?: string
  }>({ active: false, checking: false, cancelling: false, recovering: false, copied: false })
  type Attempt = {
    id: string
    method: "browser" | "device"
    client: typeof props.client
    scope: string
    server: string
    epoch: number
    opened?: string
    reading?: boolean
  }
  let current: Attempt | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let epoch = 0
  let alive = true
  const valid = (attempt: Attempt) => alive && attempt.epoch === epoch && attempt.scope === props.scope
  const busy = () => store.active || store.checking || store.cancelling
  const message = (error: unknown) =>
    formatServerError(
      typeof error === "object" && error !== null && "error" in error && typeof error.error === "string"
        ? error.error
        : error,
      language.t,
    )
  const detach = () => {
    epoch++
    clearTimeout(timer)
    const attempt = current
    current = undefined
    if (attempt)
      void attempt.client.native
        .cancelLogin({ id: attempt.id }, { signal: AbortSignal.timeout(10_000) })
        .catch(() => {})
  }
  createEffect(
    on(
      () => props.scope,
      () => {
        detach()
        setStore({
          status: undefined,
          active: false,
          checking: false,
          cancelling: false,
          recovering: false,
          copied: false,
          error: undefined,
        })
      },
    ),
  )
  onCleanup(() => {
    alive = false
    detach()
  })

  function open(url: string) {
    try {
      platform.openLink(url)
    } catch (error) {
      setStore("error", formatServerError(error, language.t))
    }
  }

  async function accept(attempt: Attempt, status: NativeAuthStatus | undefined) {
    if (!valid(attempt) || current !== attempt) return
    if (
      !status ||
      status.id !== attempt.id ||
      ((status.state === "starting" || status.state === "pending") && status.method !== attempt.method)
    )
      throw new Error(language.t("native.login.invalid"))
    setStore({ status, error: undefined, recovering: false })
    if (status.state === "starting" || status.state === "pending") {
      if (status.url && attempt.opened !== status.url) {
        attempt.opened = status.url
        open(status.url)
      }
      clearTimeout(timer)
      timer = setTimeout(() => void poll(attempt), 2_000)
      return
    }
    clearTimeout(timer)
    current = undefined
    setStore({ active: false, cancelling: false })
    if (status.state !== "complete") {
      setStore("error", status.error)
      return
    }
    setStore("checking", true)
    await refreshNativeStatus(attempt.server)
      .catch((error: unknown) => {
        if (valid(attempt)) setStore("error", formatServerError(error, language.t))
      })
      .finally(() => {
        if (valid(attempt)) setStore("checking", false)
      })
  }

  async function poll(attempt: Attempt, original?: unknown) {
    if (!valid(attempt) || current !== attempt || attempt.reading || store.cancelling) return
    attempt.reading = true
    clearTimeout(timer)
    await attempt.client.native
      .loginStatus({ id: attempt.id }, { signal: AbortSignal.timeout(10_000), throwOnError: false })
      .then((response) => {
        if (!valid(attempt) || current !== attempt) return
        if (response.response?.status === 404) {
          current = undefined
          setStore({ active: false, recovering: false, status: undefined, error: message(original ?? response.error) })
          return
        }
        if (response.error) throw response.error
        return accept(attempt, response.data)
      })
      .catch((error: unknown) => {
        if (!valid(attempt) || current !== attempt) return
        // An unknown network outcome must retain its UUID. Retry the lookup,
        // rather than starting a second browser/device authorization attempt.
        setStore({ recovering: true, error: message(error) })
      })
      .finally(() => {
        attempt.reading = false
      })
  }

  async function start(method: "browser" | "device") {
    if (props.disabled || busy()) return
    const attempt: Attempt = {
      id: crypto.randomUUID(),
      method,
      client: props.client,
      scope: props.scope,
      server: props.server,
      epoch,
    }
    current = attempt
    setStore({
      active: true,
      status: { id: attempt.id, method, state: "starting" },
      recovering: false,
      copied: false,
      error: undefined,
    })
    await attempt.client.native
      .login({ id: attempt.id, method }, { signal: AbortSignal.timeout(15_000), throwOnError: false })
      .then(async (response) => {
        if (valid(attempt)) {
          if (current !== attempt) return
          // A rejected request did not create this attempt. In particular, a
          // 409 belongs to another login; do not cancel or retry that login.
          const status = response.response?.status
          if (status && status >= 400 && status < 500) {
            current = undefined
            setStore({ active: false, status: undefined, error: message(response.error) })
            return
          }
          if (response.error) throw response.error
          return accept(attempt, response.data)
        }
        // Closing settings can race the initial POST; cancel again once that
        // request settles, using only this attempt and its original server.
        await attempt.client.native
          .cancelLogin({ id: attempt.id }, { signal: AbortSignal.timeout(10_000) })
          .catch(() => {})
      })
      .catch((error: unknown) => poll(attempt, error))
  }

  async function cancel() {
    const attempt = current
    if (!attempt || store.cancelling) return
    clearTimeout(timer)
    setStore("cancelling", true)
    await attempt.client.native
      .cancelLogin({ id: attempt.id }, { signal: AbortSignal.timeout(10_000) })
      .then((response) => accept(attempt, response.data))
      .catch((error: unknown) => {
        if (valid(attempt) && current === attempt) setStore({ recovering: true, error: message(error) })
      })
      .finally(() => {
        if (valid(attempt)) setStore("cancelling", false)
      })
  }

  async function copy() {
    if (!store.status?.code) return
    const id = store.status.id
    await navigator.clipboard
      .writeText(store.status.code)
      .then(() => {
        if (alive && store.status?.id === id) setStore("copied", true)
      })
      .catch((error: unknown) => {
        if (alive && store.status?.id === id) setStore("error", formatServerError(error, language.t))
      })
  }

  return (
    <div class="flex flex-col gap-3" data-component="native-login">
      <p class="text-13-regular text-text-weak">
        {language.t(server.isLocal() ? "native.login.description" : "native.login.remote")}
      </p>
      <Show when={!busy()}>
        <div class="flex flex-wrap gap-2">
          <Button
            disabled={props.disabled}
            onClick={() => void start(server.isLocal() ? "browser" : "device")}
            data-action="native-login"
          >
            {language.t("native.login.start")}
          </Button>
          <Show when={server.isLocal()}>
            <Button
              variant="secondary"
              disabled={props.disabled}
              onClick={() => void start("device")}
              data-action="native-login-device"
            >
              {language.t("native.login.device")}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={store.status}>
        {(status) => (
          <>
            <p class="text-13-regular text-text-weak" role="status">
              {language.t(
                store.checking
                  ? "native.login.verifying"
                  : store.recovering
                    ? "native.login.recovering"
                    : `native.login.${status().state}`,
              )}
            </p>
            <Show when={store.active && status().code}>
              {(code) => (
                <div class="flex items-center gap-2">
                  <code
                    class="select-all rounded border border-border-base px-3 py-2 text-14-medium"
                    data-component="native-login-code"
                  >
                    {code()}
                  </code>
                  <Button variant="secondary" size="small" onClick={() => void copy()} data-action="native-login-copy">
                    {language.t(store.copied ? "native.login.copied" : "native.login.copy")}
                  </Button>
                </div>
              )}
            </Show>
            <Show when={store.active && status().expiresAt}>
              {(expires) => (
                <p class="text-12-regular text-text-weak">
                  {language.t("native.login.expires", { time: new Date(expires()).toLocaleTimeString() })}
                </p>
              )}
            </Show>
            <Show when={store.active}>
              <div class="flex flex-wrap gap-2">
                <Show when={status().url}>
                  {(url) => (
                    <Button variant="secondary" onClick={() => open(url())} data-action="native-login-open">
                      {language.t("native.login.open")}
                    </Button>
                  )}
                </Show>
                <Show when={store.recovering}>
                  <Button
                    variant="secondary"
                    disabled={store.cancelling}
                    onClick={() => current && void poll(current)}
                    data-action="native-login-check"
                  >
                    {language.t("native.login.check")}
                  </Button>
                </Show>
                <Button
                  variant="ghost"
                  disabled={store.cancelling}
                  onClick={() => void cancel()}
                  data-action="native-login-cancel"
                >
                  {language.t(store.cancelling ? "native.login.cancelling" : "native.login.cancel")}
                </Button>
              </div>
              <p class="text-12-regular text-text-weak">{language.t("native.login.closeHelp")}</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={store.error}>
        {(error) => (
          <p role="alert" class="text-13-regular text-text-critical-base break-words">
            {error()}
          </p>
        )}
      </Show>
      <Button
        variant="ghost"
        size="small"
        onClick={() => platform.openLink("https://learn.chatgpt.com/docs/auth")}
        data-action="native-login-help"
      >
        {language.t("native.login.help")}
      </Button>
    </div>
  )
}
