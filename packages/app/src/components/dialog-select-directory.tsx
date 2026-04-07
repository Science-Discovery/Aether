import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List } from "@opencode-ai/ui/list"
import type { ListRef } from "@opencode-ai/ui/list"
import { showToast } from "@opencode-ai/ui/toast"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import fuzzysort from "fuzzysort"
import { createMemo, createResource, createSignal, onMount, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { picked } from "./pick-folder"
import { useLayout } from "@/context/layout"

interface DialogSelectDirectoryProps {
  title?: string
  initial?: string
  multiple?: boolean
  persistent?: boolean
  onSelect: (result: string | string[] | null) => void
}

type Row = {
  absolute: string
  search: string
  group: "recent" | "folders"
  isExpander?: true
  isCollapser?: true
  expanderCount?: number
}

function cleanInput(value: string) {
  const first = (value ?? "").split(/\r?\n/)[0] ?? ""
  return first.replace(/[\u0000-\u001F\u007F]/g, "").trim()
}

function normalizePath(input: string) {
  const v = input.replaceAll("\\", "/")
  if (v.startsWith("//") && !v.startsWith("///")) return "//" + v.slice(2).replace(/\/+/g, "/")
  return v.replace(/\/+/g, "/")
}

function normalizeDriveRoot(input: string) {
  const v = normalizePath(input)
  if (/^[A-Za-z]:$/.test(v)) return v + "/"
  return v
}

function trimTrailing(input: string) {
  const v = normalizeDriveRoot(input)
  if (v === "/") return v
  if (v === "//") return v
  if (/^[A-Za-z]:\/$/.test(v)) return v
  return v.replace(/\/+$/, "")
}

function joinPath(base: string | undefined, rel: string) {
  const b = trimTrailing(base ?? "")
  const r = trimTrailing(rel).replace(/^\/+/, "")
  if (!b) return r
  if (!r) return b
  if (b.endsWith("/")) return b + r
  return b + "/" + r
}

function rootOf(input: string) {
  const v = normalizeDriveRoot(input)
  if (v.startsWith("//")) return "//"
  if (v.startsWith("/")) return "/"
  if (/^[A-Za-z]:\//.test(v)) return v.slice(0, 3)
  return ""
}

function parentOf(input: string) {
  const v = trimTrailing(input)
  if (v === "/") return v
  if (v === "//") return v
  if (/^[A-Za-z]:\/$/.test(v)) return v

  const i = v.lastIndexOf("/")
  if (i <= 0) return "/"
  if (i === 2 && /^[A-Za-z]:/.test(v)) return v.slice(0, 3)
  return v.slice(0, i)
}

function modeOf(input: string) {
  const raw = normalizeDriveRoot(input.trim())
  if (!raw) return "relative" as const
  if (raw.startsWith("~")) return "tilde" as const
  if (rootOf(raw)) return "absolute" as const
  return "relative" as const
}

function tildeOf(absolute: string, home: string) {
  const full = trimTrailing(absolute)
  if (!home) return ""

  const hn = trimTrailing(home)
  const lc = full.toLowerCase()
  const hc = hn.toLowerCase()
  if (lc === hc) return "~"
  if (lc.startsWith(hc + "/")) return "~" + full.slice(hn.length)
  return ""
}

function displayPath(path: string, input: string, home: string) {
  const full = trimTrailing(path)
  if (modeOf(input) === "absolute") return full
  return tildeOf(full, home) || full
}

function toRow(absolute: string, home: string, group: Row["group"]): Row {
  const full = trimTrailing(absolute)
  const tilde = tildeOf(full, home)
  const withSlash = (value: string) => {
    if (!value) return ""
    if (value.endsWith("/")) return value
    return value + "/"
  }

  const search = Array.from(
    new Set([full, withSlash(full), tilde, withSlash(tilde), getFilename(full)].filter(Boolean)),
  ).join("\n")
  return { absolute: full, search, group }
}

function uniqueRows(rows: Row[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.absolute)) return false
    seen.add(row.absolute)
    return true
  })
}

function useDirectorySearch(args: {
  sdk: ReturnType<typeof useGlobalSDK>
  start: () => string | undefined
  home: () => string
}) {
  const cache = new Map<string, Promise<Array<{ name: string; absolute: string }>>>()
  let current = 0

  const scoped = (value: string) => {
    const base = args.start()
    if (!base) return

    const raw = normalizeDriveRoot(value)
    if (!raw) {
      const h = args.home()
      if (/^[A-Za-z]:\//.test(h)) return { directory: "/", path: "" }
      return { directory: trimTrailing(h), path: "" }
    }

    const h = args.home()
    if (raw === "~") return { directory: trimTrailing(h || base), path: "" }
    if (raw.startsWith("~/")) return { directory: trimTrailing(h || base), path: raw.slice(2) }

    const root = rootOf(raw)
    if (root) return { directory: trimTrailing(root), path: raw.slice(root.length) }
    return { directory: trimTrailing(base), path: raw }
  }

  const dirs = async (dir: string) => {
    const key = trimTrailing(dir)
    const existing = cache.get(key)
    if (existing) return existing

    const request = args.sdk.client.file
      .list({ directory: key, path: "" })
      .then((x) => x.data ?? [])
      .catch(() => [])
      .then((nodes) =>
        nodes
          .filter((n) => n.type === "directory")
          .map((n) => ({
            name: n.name,
            absolute: trimTrailing(normalizeDriveRoot(n.absolute)),
          })),
      )

    cache.set(key, request)
    return request
  }

  const match = async (dir: string, query: string, limit: number) => {
    const items = await dirs(dir)
    if (!query) return items.slice(0, limit).map((x) => x.absolute)
    return fuzzysort.go(query, items, { key: "name", limit }).map((x) => x.obj.absolute)
  }

  return async (filter: string) => {
    const token = ++current
    const active = () => token === current

    const value = cleanInput(filter)
    const scopedInput = scoped(value)
    if (!scopedInput) return [] as string[]

    const raw = normalizeDriveRoot(value)
    const isPath = raw.startsWith("~") || !!rootOf(raw) || raw.includes("/")
    const query = normalizeDriveRoot(scopedInput.path)

    const find = () =>
      args.sdk.client.find
        .files({ directory: scopedInput.directory, query, type: "directory", limit: 50 })
        .then((x) => x.data ?? [])
        .catch(() => [])

    if (!isPath) {
      if (!raw || rootOf(trimTrailing(scopedInput.directory)) === trimTrailing(scopedInput.directory)) {
        const items = await match(scopedInput.directory, "", 50)
        if (!active()) return []
        return items
      }
      const results = await find()
      if (!active()) return []
      return results.map((rel) => joinPath(scopedInput.directory, rel)).slice(0, 50)
    }

    const segments = query.replace(/^\/+/, "").split("/")
    const head = segments.slice(0, segments.length - 1).filter((x) => x && x !== ".")
    const tail = segments[segments.length - 1] ?? ""

    const cap = 12
    const branch = 4
    let paths = [scopedInput.directory]
    for (const part of head) {
      if (!active()) return []
      if (part === "..") {
        paths = paths.map(parentOf)
        continue
      }

      const next = (await Promise.all(paths.map((p) => match(p, part, branch)))).flat()
      if (!active()) return []
      paths = Array.from(new Set(next)).slice(0, cap)
      if (paths.length === 0) return [] as string[]
    }

    const out = (await Promise.all(paths.map((p) => match(p, tail, 50)))).flat()
    if (!active()) return []
    const deduped = Array.from(new Set(out))
    const base = raw.startsWith("~") ? trimTrailing(scopedInput.directory) : ""
    const expand = !raw.endsWith("/")
    if (!expand || !tail) {
      const items = base ? Array.from(new Set([base, ...deduped])) : deduped
      return items.slice(0, 50)
    }

    const needle = tail.toLowerCase()
    const exact = deduped.filter((p) => getFilename(p).toLowerCase() === needle)
    const target = exact[0]
    if (!target) return deduped.slice(0, 50)

    const children = await match(target, "", 30)
    if (!active()) return []
    const items = Array.from(new Set([...deduped, ...children]))
    return (base ? Array.from(new Set([base, ...items])) : items).slice(0, 50)
  }
}

export function DialogSelectDirectory(props: DialogSelectDirectoryProps) {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const layout = useLayout()

  const [filter, setFilter] = createSignal("")
  const [browsing, setBrowsing] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  let list: ListRef | undefined

  const missingBase = createMemo(() => !(sync.data.path.home || sync.data.path.directory))
  const [fallbackPath] = createResource(
    () => (missingBase() ? true : undefined),
    async () => {
      return sdk.client.path
        .get()
        .then((x) => x.data)
        .catch(() => undefined)
    },
    { initialValue: undefined },
  )

  const home = createMemo(() => sync.data.path.home || fallbackPath()?.home || "")
  const start = createMemo(
    () => sync.data.path.home || sync.data.path.directory || fallbackPath()?.home || fallbackPath()?.directory,
  )

  const directories = useDirectorySearch({
    sdk,
    home,
    start,
  })

  const RECENT_LIMIT = 5

  onMount(() => {
    const value = cleanInput(props.initial ?? "")
    if (!value) return
    list?.setFilter(value)
  })
  const recentProjects = createMemo(() => {
    const isExpanded = expanded()
    const open = new Set(layout.projects.list().map((p) => normalizeDriveRoot(p.worktree).toLowerCase()))
    const all = sync.project
      .recent()
      .filter((item) => !open.has(normalizeDriveRoot(item.directory).toLowerCase()))
      .map((item) => {
        const row = toRow(item.directory, home(), "recent")
        const name = item.name || getFilename(item.directory)
        return { ...row, search: `${row.search}\n${name}` }
      })

    if (!isExpanded && all.length > RECENT_LIMIT) {
      return [
        ...all.slice(0, RECENT_LIMIT),
        {
          absolute: "__expander__",
          search: "",
          group: "recent" as const,
          isExpander: true as const,
          expanderCount: all.length - RECENT_LIMIT,
        },
      ]
    }
    if (isExpanded && all.length > RECENT_LIMIT) {
      return [
        ...all,
        {
          absolute: "__collapser__",
          search: "",
          group: "recent" as const,
          isCollapser: true as const,
        },
      ]
    }
    return all
  })

  const items = async (value: string) => {
    const recentRows = recentProjects() // sync before await — tracks expanded() via memo

    const raw = normalizeDriveRoot(cleanInput(value))
    const isAbs = raw && rootOf(raw)
    const filteredRecent = isAbs
      ? recentRows.filter((row) => {
          if (row.isExpander || row.isCollapser) return true
          return row.absolute.toLowerCase().startsWith(trimTrailing(raw).toLowerCase())
        })
      : recentRows

    const results = await directories(value)
    const directoryRows = results.map((absolute) => toRow(absolute, home(), "folders"))
    return uniqueRows([...filteredRecent, ...directoryRows])
  }

  function resolve(absolute: string) {
    props.onSelect(props.multiple ? [absolute] : absolute)
    dialog.close()
  }

  function goUp() {
    const current = filter()
    if (!current) return
    const trimmed = trimTrailing(current)
    const parent = getDirectory(trimmed)
    list?.setFilter(parent ?? "")
  }

  function openOrCreate() {
    const raw = normalizeDriveRoot(cleanInput(filter()))
    if (!raw) return
    let absolute: string
    if (raw === "~" || raw.startsWith("~/")) {
      absolute = trimTrailing(raw === "~" ? home() : joinPath(home(), raw.slice(2)))
    } else if (rootOf(raw)) {
      absolute = trimTrailing(raw)
    } else {
      absolute = trimTrailing(joinPath(start() ?? "", raw))
    }
    resolve(absolute)
  }

  return (
    <Dialog title={props.title ?? language.t("command.project.open")} persistent={props.persistent}>
      <List
        search={{
          placeholder: language.t("dialog.directory.search.placeholder"),
          autofocus: true,
          prefix: (
            <div class="flex items-center gap-1">
              <Button
                icon="folder"
                size="small"
                variant="ghost"
                disabled={browsing()}
                onClick={async () => {
                  if (browsing()) return
                  setBrowsing(true)
                  try {
                    const result = await sdk.client.file.pickFolder()
                    const path = picked(result.data, showToast, language.t("common.requestFailed"))
                    if (path) list?.setFilter(path)
                  } finally {
                    setBrowsing(false)
                  }
                }}
              >
                {language.t("dialog.directory.browse")}
              </Button>
              <Show when={filter()}>
                <Button icon="arrow-up" size="small" variant="ghost" onClick={goUp} />
              </Show>
            </div>
          ),
          action: (
            <Button size="small" variant="secondary" disabled={!filter()} onClick={openOrCreate}>
              {language.t("dialog.directory.confirm")}
            </Button>
          ),
        }}
        emptyMessage={language.t("dialog.directory.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(x) => x.absolute}
        filterKeys={["search"]}
        groupBy={(item) => item.group}
        sortGroupsBy={(a, b) => {
          const order = { recent: 0, folders: 1 }
          return (order[a.category as keyof typeof order] ?? 2) - (order[b.category as keyof typeof order] ?? 2)
        }}
        groupHeader={(group) => {
          if (group.category === "recent") return language.t("dialog.directory.existingProjects")
          return language.t("dialog.newProject.title")
        }}
        ref={(r) => (list = r)}
        onFilter={(value) => {
          const normalized = value.replaceAll("\\", "/")
          setFilter(cleanInput(normalized))
          if (normalized !== value) list?.setFilter(normalized)
        }}
        onKeyEvent={(e, item) => {
          if (e.key !== "Tab") return
          if (e.shiftKey) return
          if (!item || item.isExpander || item.isCollapser) return

          e.preventDefault()
          e.stopPropagation()

          const value = displayPath(item.absolute, filter(), home())
          list?.setFilter(value.endsWith("/") ? value : value + "/")
        }}
        onSelect={(path) => {
          if (!path) return
          if (path.isExpander) {
            setExpanded(true)
            return
          }
          if (path.isCollapser) {
            setExpanded(false)
            return
          }
          const value = displayPath(path.absolute, filter(), home())
          list?.setFilter(value.endsWith("/") ? value : value + "/")
        }}
      >
        {(item) => {
          if (item.isExpander) {
            return (
              <div class="w-full flex items-center gap-x-3 text-14-regular text-text-weak">
                <span>展开更多 ({item.expanderCount})</span>
              </div>
            )
          }
          if (item.isCollapser) {
            return (
              <div class="w-full flex items-center gap-x-3 text-14-regular text-text-weak">
                <span>收起</span>
              </div>
            )
          }

          const path = displayPath(item.absolute, filter(), home())

          if (path === "~") {
            return (
              <div class="w-full flex items-center gap-x-3 rounded-md">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-strong whitespace-nowrap">~</span>
                  <span class="text-text-weak whitespace-nowrap">/</span>
                </div>
              </div>
            )
          }
          return (
            <div class="w-full flex items-center gap-x-3 rounded-md">
              <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
              <div class="flex items-center text-14-regular min-w-0">
                <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                  {getDirectory(path)}
                </span>
                <span class="text-text-strong whitespace-nowrap">{getFilename(path)}</span>
                <span class="text-text-weak whitespace-nowrap">/</span>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
