export function base() {
  const env = import.meta.env as unknown as { VITE_BASE_PATH?: string }
  const raw = (globalThis as { __AETHER_BASE_PATH__?: string }).__AETHER_BASE_PATH__ ?? env.VITE_BASE_PATH
  if (!raw || raw === "." || raw === "./" || raw === "/") return "/"
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return "/"
  const path = raw.startsWith("/") ? raw : `/${raw}`
  return path.replace(/\/+$/, "") || "/"
}

export function href(path: string) {
  const root = base()
  return root === "/" ? path : `${root}${path}`
}
