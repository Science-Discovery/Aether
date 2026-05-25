import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { Persist, persisted } from "@/utils/persist"

const TIMEOUT = 15_000
const BASE_URL =
  (
    import.meta.env.VITE_AETHER_AUTH_URL ??
    (globalThis as { __AETHER_AUTH_URL__?: string }).__AETHER_AUTH_URL__ ??
    "https://aether.aiphys.cn"
  ).replace(/\/+$/, "") || "https://aether.aiphys.cn"

interface Account {
  id: string
  email: string
  name: string
  role: string
  created_at: string
  updated_at: string
}

interface AuthState {
  session_token: string | undefined
  expires_at: string | undefined
  account: Account | undefined
}

type AuthBody = {
  data?: {
    account?: Account
    session_token?: string
    expires_at?: string
  }
  error?: {
    code?: string
    message?: string
  }
}

const defaultState: AuthState = {
  session_token: undefined,
  expires_at: undefined,
  account: undefined,
}

function failure(message: string, code: string, status: number) {
  const error = new Error(message) as Error & { code: string; status: number }
  error.code = code
  error.status = status
  return error
}

function session(body: AuthBody) {
  const data = body.data
  if (!data?.account || !data.session_token || !data.expires_at) {
    throw failure("Authentication response is missing session fields", "INVALID_RESPONSE", 0)
  }
  return {
    account: data.account,
    session_token: data.session_token,
    expires_at: data.expires_at,
  }
}

async function request(path: string, opts: RequestInit & { token?: string } = {}) {
  const { token, ...fetchOpts } = opts
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOpts.headers as Record<string, string>),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, { ...fetchOpts, headers, signal: abort.signal })
    .catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw failure("Request timed out", "TIMEOUT", 0)
      }
      throw failure("Unable to reach authentication service", "NETWORK_ERROR", 0)
    })
    .finally(() => clearTimeout(timer))

  const body = (await res.json().catch(() => {
    throw failure("Authentication service returned invalid JSON", "INVALID_JSON", res.status)
  })) as AuthBody

  if (!res.ok) {
    const code = body?.error?.code ?? "UNKNOWN"
    const message = body?.error?.message ?? "Request failed"
    throw failure(message, code, res.status)
  }

  return body
}

export const { use: useAuth, provider: AuthProvider } = createSimpleContext({
  name: "Auth",
  init: () => {
    const [store, setStore, , ready] = persisted(
      Persist.global("auth.v2", ["auth.v1"]),
      createStore<AuthState>(defaultState),
    )

    const isAuthenticated = createMemo(() => !!store.session_token && !!store.account)
    const account = createMemo(() => store.account)
    const token = createMemo(() => store.session_token)

    const expired = createMemo(() => {
      if (!store.expires_at) return false
      return new Date(store.expires_at).getTime() < Date.now()
    })

    function save(body: AuthBody) {
      const next = session(body)
      setStore(next)
      return next.account
    }

    async function send(email: string) {
      await request("/v2/auth/register/code", {
        method: "POST",
        body: JSON.stringify({ email }),
      })
    }

    async function register(email: string, password: string, name: string, code: string) {
      const body = await request("/v2/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name, verification_code: code }),
      })

      return save(body)
    }

    async function login(email: string, password: string) {
      const body = await request("/v2/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      })

      return save(body)
    }

    async function forgot(email: string) {
      await request("/v2/auth/password/forgot", {
        method: "POST",
        body: JSON.stringify({ email }),
      })
    }

    async function reset(token: string, password: string) {
      await request("/v2/auth/password/reset", {
        method: "POST",
        body: JSON.stringify({ reset_token: token, new_password: password }),
      })
      setStore(defaultState)
    }

    async function logout() {
      const token = store.session_token
      // Clear local state immediately for instant UI feedback
      setStore("session_token", undefined)
      setStore("expires_at", undefined)
      setStore("account", undefined)
      // Fire server-side invalidation in background
      if (token) {
        request("/v2/auth/logout", { method: "POST", token }).catch(() => {})
      }
    }

    async function me() {
      if (!store.session_token) return undefined
      try {
        const body = await request("/v2/auth/me", {
          token: store.session_token,
        })
        const account = body.data?.account
        if (!account) throw failure("Authentication response is missing account", "INVALID_RESPONSE", 0)
        setStore("account", account)
        return account
      } catch {
        // session invalid, clear local state
        setStore(defaultState)
        return undefined
      }
    }

    // on startup, validate session if token exists
    createEffect(() => {
      if (!ready()) return
      if (!store.session_token) return
      if (expired()) {
        setStore(defaultState)
        return
      }
      void me()
    })

    return {
      ready,
      get isAuthenticated() {
        return isAuthenticated()
      },
      get account() {
        return account()
      },
      get token() {
        return token()
      },
      register,
      send,
      login,
      forgot,
      reset,
      logout,
      me,
    }
  },
})
