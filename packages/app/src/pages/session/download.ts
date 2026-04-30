const fail = async (res: Response) => {
  const data = await res.json().catch(() => undefined)
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return data.error
  }
  return `Download failed (${res.status})`
}

const name = (res: Response, path: string) => {
  const head = res.headers.get("Content-Disposition")
  const utf = head?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (utf?.[1]) {
    try {
      return decodeURIComponent(utf[1])
    } catch {
      // ignore malformed header
    }
  }
  const match = head?.match(/filename="([^"]+)"/)
  if (match?.[1]) return match[1]
  const part = path.split("/").pop()
  return part || "download"
}

export const pull = async (input: { url: string; dir: string; path: string; fetch?: typeof fetch }) => {
  const ascii = /^[\x00-\x7F]*$/.test(input.dir)
  const head = ascii ? input.dir : encodeURIComponent(input.dir)
  const req = input.fetch ?? fetch
  const url = new URL(`${input.url}/file/download`)
  url.searchParams.set("path", input.path)
  const res = await req(url, {
    headers: {
      "x-opencode-directory": head,
    },
  })

  if (!res.ok) {
    throw new Error(await fail(res))
  }

  return {
    name: name(res, input.path),
    blob: await res.blob(),
  }
}

export const save = async (input: Parameters<typeof pull>[0]) => {
  const out = await pull(input)
  const url = URL.createObjectURL(out.blob)
  const link = document.createElement("a")
  link.href = url
  link.download = out.name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  return out.name
}
