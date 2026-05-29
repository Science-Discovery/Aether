import { app } from "electron"
import { SETTINGS_STORE } from "./persist-names"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const PROXY_ENABLED_KEY = "proxyEnabled"
export const PROXY_HTTP_HOST_KEY = "proxyHttpHost"
export const PROXY_HTTP_PORT_KEY = "proxyHttpPort"
export const PROXY_HTTPS_HOST_KEY = "proxyHttpsHost"
export const PROXY_HTTPS_PORT_KEY = "proxyHttpsPort"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL === "prod"
export { SETTINGS_STORE }
