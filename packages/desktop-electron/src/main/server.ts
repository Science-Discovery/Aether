import { serve, type CommandChild } from "./cli"
import {
  DEFAULT_SERVER_URL_KEY,
  PROXY_ENABLED_KEY,
  PROXY_HTTPS_HOST_KEY,
  PROXY_HTTPS_PORT_KEY,
  PROXY_HTTP_HOST_KEY,
  PROXY_HTTP_PORT_KEY,
  WSL_ENABLED_KEY,
} from "./constants"
import { store } from "./store"

export type WslConfig = { enabled: boolean }
export type ProxyConfig = {
  enabled: boolean
  http: {
    host: string
    port: number
  }
  https: {
    host: string
    port: number
  }
}

export type HealthCheck = { wait: Promise<void> }

export function getDefaultServerUrl(): string | null {
  const value = store.get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    store.set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  store.delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = store.get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  store.set(WSL_ENABLED_KEY, config.enabled)
}

export function getProxyConfig(): ProxyConfig {
  const enabled = store.get(PROXY_ENABLED_KEY)
  const httpHost = store.get(PROXY_HTTP_HOST_KEY)
  const httpPort = store.get(PROXY_HTTP_PORT_KEY)
  const httpsHost = store.get(PROXY_HTTPS_HOST_KEY)
  const httpsPort = store.get(PROXY_HTTPS_PORT_KEY)
  return {
    enabled: typeof enabled === "boolean" ? enabled : false,
    http: {
      host: typeof httpHost === "string" ? httpHost : "",
      port: typeof httpPort === "number" ? httpPort : 8080,
    },
    https: {
      host: typeof httpsHost === "string" ? httpsHost : "",
      port: typeof httpsPort === "number" ? httpsPort : 8080,
    },
  }
}

export function setProxyConfig(config: ProxyConfig) {
  const httpHost = config.http.host.trim()
  const httpPort = Number.isInteger(config.http.port) ? config.http.port : 8080
  const httpsHost = config.https.host.trim()
  const httpsPort = Number.isInteger(config.https.port) ? config.https.port : 8080
  if (config.enabled && !httpHost && !httpsHost) {
    throw new Error("Proxy host is required for HTTP or HTTPS")
  }
  if (config.enabled && httpHost && (httpPort < 1 || httpPort > 65535)) {
    throw new Error("HTTP proxy port must be an integer between 1 and 65535")
  }
  if (config.enabled && httpsHost && (httpsPort < 1 || httpsPort > 65535)) {
    throw new Error("HTTPS proxy port must be an integer between 1 and 65535")
  }
  store.set(PROXY_ENABLED_KEY, config.enabled)
  store.set(PROXY_HTTP_HOST_KEY, httpHost)
  store.set(PROXY_HTTP_PORT_KEY, httpPort)
  store.set(PROXY_HTTPS_HOST_KEY, httpsHost)
  store.set(PROXY_HTTPS_PORT_KEY, httpsPort)
}

export function spawnLocalServer(hostname: string, port: number, password: string) {
  const { child, exit, events } = serve(hostname, port, password, getProxyConfig())

  const wait = (async () => {
    const url = `http://${hostname}:${port}`

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) return
      }
    }

    const terminated = async () => {
      const payload = await exit
      throw new Error(
        `Sidecar terminated before becoming healthy (code=${payload.code ?? "unknown"} signal=${
          payload.signal ?? "unknown"
        })`,
      )
    }

    await Promise.race([ready(), terminated()])
  })()

  return { child, health: { wait }, events }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

export type { CommandChild }
