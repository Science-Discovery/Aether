export type Batch = {
  dirs: string[]
  files: {
    path: string
    file: File
  }[]
}

type PickedFile = File & {
  webkitRelativePath?: string
}

type WebItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
  webkitGetAsEntry?: () => WebEntry | null
}

type WebEntry = {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath?: string
  file?: (ok: (file: File) => void, fail?: (err?: DOMException) => void) => void
  createReader?: () => {
    readEntries: (ok: (list: WebEntry[]) => void, fail?: (err?: DOMException) => void) => void
  }
}

export type Reply = {
  ok: boolean
  dirs: number
  created: number
  updated: number
  failed: {
    path: string
    error: string
  }[]
}

const clean = (input: string) => {
  const list = input
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .filter((part) => part !== ".")

  if (list.some((part) => part === "..")) return
  return list.join("/")
}

export const merge = (out: Batch, next: Batch) => {
  const dirs = new Set([...out.dirs, ...next.dirs])
  const files = [...out.files]
  const seen = new Set(files.map((item) => item.path))

  for (const item of next.files) {
    if (seen.has(item.path)) continue
    seen.add(item.path)
    files.push(item)
  }

  return {
    dirs: [...dirs],
    files,
  }
}

const fromFile = (file: PickedFile) => {
  const path = clean(file.webkitRelativePath || file.name)
  if (!path) return { dirs: [], files: [] }
  return {
    dirs: [],
    files: [{ path, file }],
  } satisfies Batch
}

const fromHandle = async (item: FileSystemHandle, root = ""): Promise<Batch> => {
  const path = clean(root ? `${root}/${item.name}` : item.name)
  if (!path) return { dirs: [], files: [] }

  if (item.kind === "file") {
    const file = await (item as FileSystemFileHandle).getFile()
    return {
      dirs: [],
      files: [{ path, file }],
    }
  }

  let out: Batch = {
    dirs: [path],
    files: [],
  }

  for await (const child of (item as FileSystemDirectoryHandle).values()) {
    out = merge(out, await fromHandle(child, path))
  }

  return out
}

const fromEntry = async (item: WebEntry, root = ""): Promise<Batch> => {
  const base = item.fullPath ? item.fullPath.replace(/^\/+/, "") : root ? `${root}/${item.name}` : item.name
  const path = clean(base)
  if (!path) return { dirs: [], files: [] }

  if (item.isFile) {
    const file = await new Promise<File>((ok, fail) => {
      if (!item.file) {
        fail?.(new DOMException("Missing file entry"))
        return
      }
      item.file(ok, fail)
    })
    return {
      dirs: [],
      files: [{ path, file }],
    }
  }

  const reader = item.createReader?.()
  if (!reader) {
    return {
      dirs: [path],
      files: [],
    }
  }

  let out: Batch = {
    dirs: [path],
    files: [],
  }

  while (true) {
    const list = await new Promise<WebEntry[]>((ok, fail) => reader.readEntries(ok, fail))
    if (list.length === 0) return out
    for (const child of list) {
      out = merge(out, await fromEntry(child, path))
    }
  }
}

export const isExternal = (data: DataTransfer | null | undefined) => !!data?.types.includes("Files")

export const fromList = (list: Iterable<File>) =>
  [...list].reduce<Batch>((out, item) => merge(out, fromFile(item as PickedFile)), {
    dirs: [],
    files: [],
  })

export const fromDir = (item: FileSystemDirectoryHandle) => fromHandle(item)

export const fromDrop = async (data: DataTransfer) => {
  const items = [...data.items] as WebItem[]

  if (items.some((item) => !!item.getAsFileSystemHandle)) {
    // Call getAsFileSystemHandle() synchronously on all items before any await,
    // because DataTransferItem objects become stale after the first await.
    const handlePromises = items.map((item) => item.getAsFileSystemHandle?.() ?? Promise.resolve(null))
    let out: Batch = { dirs: [], files: [] }
    for (const promise of handlePromises) {
      const handle = await promise
      if (!handle) continue
      out = merge(out, await fromHandle(handle))
    }
    return out
  }

  if (items.some((item) => !!item.webkitGetAsEntry)) {
    // Call webkitGetAsEntry() synchronously on all items before any await,
    // because DataTransferItem objects become stale after the first await.
    const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null)
    let out: Batch = { dirs: [], files: [] }
    for (const entry of entries) {
      if (!entry) continue
      out = merge(out, await fromEntry(entry))
    }
    return out
  }

  // Capture files synchronously before any async work
  const files = [...data.files]
  return fromList(files)
}

const err = async (res: Response) => {
  const data = await res.json().catch(() => undefined)
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return data.error
  }
  return `Upload failed (${res.status})`
}

export const send = async (input: { url: string; dir: string; target: string; batch: Batch; fetch?: typeof fetch }) => {
  const body = new FormData()
  body.append("target", input.target)
  body.append("dirs", JSON.stringify(input.batch.dirs))
  body.append("paths", JSON.stringify(input.batch.files.map((item) => item.path)))

  for (const item of input.batch.files) {
    body.append("files", item.file, item.file.name)
  }

  const ascii = /^[\x00-\x7F]*$/.test(input.dir)
  const head = ascii ? input.dir : encodeURIComponent(input.dir)
  const req = input.fetch ?? fetch
  const res = await req(new URL("file/upload", `${input.url.replace(/\/+$/, "")}/`), {
    method: "POST",
    headers: {
      "x-opencode-directory": head,
    },
    body,
  })

  if (!res.ok) {
    throw new Error(await err(res))
  }

  return (await res.json()) as Reply
}
