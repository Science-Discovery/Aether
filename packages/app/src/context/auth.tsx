import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { Persist, persisted } from "@/utils/persist"

const BASE_URL = "https://skill.aiphys.cn"

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

const defaultState: AuthState = {
  session_token: undefined,
  expires_at: undefined,
  account: undefined,
}

async function request(path: string, opts: RequestInit & { token?: string } = {}) {
  const { token, ...fetchOpts } = opts
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOpts.headers as Record<string, string>),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, { ...fetchOpts, headers })
  const body = await res.json()

  if (!res.ok) {
    const code = body?.error?.code ?? "UNKNOWN"
    const message = body?.error?.message ?? "Request failed"
    const error = new Error(message) as Error & { code: string; status: number }
    error.code = code
    error.status = res.status
    throw error
  }

  return body
}

export const { use: useAuth, provider: AuthProvider } = createSimpleContext({
  name: "Auth",
  init: () => {
    const [store, setStore, , ready] = persisted(
      Persist.global("auth.v1"),
      createStore<AuthState>(defaultState),
    )

    const isAuthenticated = createMemo(() => !!store.session_token && !!store.account)
    const account = createMemo(() => store.account)
    const token = createMemo(() => store.session_token)

    const expired = createMemo(() => {
      if (!store.expires_at) return false
      return new Date(store.expires_at).getTime() < Date.now()
    })

    async function register(email: string, password: string, name: string) {
      const body = await request("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      })

      const { account, session_token, expires_at } = body.data
      setStore({ session_token, expires_at, account })
      return account as Account
    }

    async function login(email: string, password: string) {
      const body = await request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      })

      const { account, session_token, expires_at } = body.data
      setStore({ session_token, expires_at, account })
      return account as Account
    }

    async function logout() {
      const token = store.session_token
      // Clear local state immediately for instant UI feedback
      setStore("session_token", undefined)
      setStore("expires_at", undefined)
      setStore("account", undefined)
      // Fire server-side invalidation in background
      if (token) {
        request("/v1/auth/logout", { method: "POST", token }).catch(() => {})
      }
    }

    async function me() {
      if (!store.session_token) return undefined
      try {
        const body = await request("/v1/auth/me", {
          token: store.session_token,
        })
        setStore("account", body.data.account)
        return body.data.account as Account
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
      login,
      logout,
      me,
    }
  },
})