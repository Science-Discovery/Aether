export const deepLinkEvent = "opencode:deep-link"

export type ServerUrlResult = {
  url: string
  username?: string
  password?: string
}

export function parseServerUrl(input: string): ServerUrlResult | undefined {
  const trimmed = input.trim()
  if (!trimmed) return
  if (trimmed.startsWith("opencode://")) return
  if (trimmed.startsWith("/")) return

  let url: URL
  try {
    const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
    url = new URL(withProtocol)
  } catch {
    return
  }

  const result: ServerUrlResult = {
    url: `${url.protocol}//${url.host}`,
  }
  if (url.username) result.username = decodeURIComponent(url.username)
  if (url.password) result.password = decodeURIComponent(url.password)

  return result
}

const parseUrl = (input: string) => {
  if (!input.startsWith("opencode://")) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  try {
    return new URL(input)
  } catch {
    return
  }
}

export const parseDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const parseNewSessionDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (!url) return
  if (url.hostname !== "new-session") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  const prompt = url.searchParams.get("prompt") || undefined
  if (!prompt) return { directory }
  return { directory, prompt }
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

export const collectNewSessionDeepLinks = (urls: string[]) =>
  urls.map(parseNewSessionDeepLink).filter((link): link is { directory: string; prompt?: string } => !!link)

type OpenCodeWindow = Window & {
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: OpenCodeWindow) => {
  const pending = target.__OPENCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = []
  return pending
}
