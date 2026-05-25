export function message(err: unknown, fallback: string, auth: string) {
  const code = (err as Error & { code?: string }).code
  if (code === "TIMEOUT" || code === "NETWORK_ERROR") return auth
  return (err as Error).message || fallback
}

export function scrub() {
  const url = new URL(location.href)
  if (!url.searchParams.has("reset_token")) return
  url.searchParams.delete("reset_token")
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`)
}
