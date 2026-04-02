import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List } from "@opencode-ai/ui/list"
import type { ListRef } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import fuzzysort from "fuzzysort"
import { createMemo, createResource, createSignal, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"

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
  group: "recent" | "folders" | "create"
  isExpander?: true
  isCollapser?: true
  isCreate?: true
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

function resolveNewPath(value: string, home: string, start: string) {
  const raw = normalizeDriveRoot(value.trim())
  if (!raw) return undefined
  let absolute: string
  if (raw === "~" || raw.startsWith("~/")) {
    absolute = trimTrailing(raw === "~" ? home : joinPath(home, raw.slice(2)))
  } else if (rootOf(raw)) {
    absolute = trimTrailing(raw)
  } else {
    absolute = trimTrailing(joinPath(start, raw))
  }
  const name = getFilename(absolute)
  if (!name) return undefined
  const parent = parentOf(absolute)
  return { parent, name, full: absolute }
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
    if (!raw) return { directory: trimTrailing(base), path: "" }

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
      // When start is a root path (e.g. "/" on Windows), use directory listing instead of fuzzy search
      if (rootOf(trimTrailing(scopedInput.directory)) === trimTrailing(scopedInput.directory)) {
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

  const [filter, setFilter] = createSignal("")
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null)
  const [browsing, setBrowsing] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [hidden, setHidden] = persisted(Persist.global("recent-projects-hidden"), createStore({ dirs: [] as string[] }))
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
    setSelectedPath(trimTrailing(normalizeDriveRoot(value)))
  })
  const recentProjects = createMemo(() => {
    const isExpanded = expanded()
    const known = sync.data.project
    const hiddenSet = new Set(hidden.dirs)
    const all = known
      .map((project) => {
        const row = toRow(project.worktree, home(), "recent")
        const name = project.name || getFilename(project.worktree)
        return { ...row, search: `${row.search}\n${name}` }
      })
      .filter((r) => !hiddenSet.has(r.absolute))

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
    const results = await directories(value)
    const directoryRows = results.map((absolute) => toRow(absolute, home(), "folders"))
    const rows = uniqueRows([...recentRows, ...directoryRows])

    if (value) {
      const resolved = resolveNewPath(value, home(), start() ?? "")
      if (resolved && !rows.find((r) => r.absolute === resolved.full)) {
        return [{ absolute: resolved.full, search: value, group: "create" as const, isCreate: true as const }, ...rows]
      }
    }
    return rows
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

  return (
    <Dialog title={props.title ?? language.t("command.project.open")} persistent={props.persistent}>
      <List
        search={{
          placeholder: language.t("dialog.directory.search.placeholder"),
          autofocus: true,
          action: (
            <div class="flex items-center gap-1">
              <Show when={filter()}>
                <Button icon="arrow-left" size="small" variant="ghost" onClick={goUp} />
              </Show>
              <Button
                icon="folder"
                size="small"
                variant="secondary"
                disabled={browsing()}
                onClick={async () => {
                  if (browsing()) return
                  setBrowsing(true)
                  try {
                    const result = await sdk.client.file.pickFolder()
                    const picked = result.data?.path
                    if (picked) {
                      list?.setFilter(picked)
                      setSelectedPath(picked)
                    }
                  } finally {
                    setBrowsing(false)
                  }
                }}
              >
                {language.t("dialog.newProject.browse")}
              </Button>
            </div>
          ),
        }}
        emptyMessage={language.t("dialog.directory.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(x) => (x.isCreate ? "__create__" : x.absolute)}
        filterKeys={["search"]}
        groupBy={(item) => item.group}
        sortGroupsBy={(a, b) => {
          const order = { create: 0, recent: 1, folders: 2 }
          return (order[a.category as keyof typeof order] ?? 3) - (order[b.category as keyof typeof order] ?? 3)
        }}
        groupHeader={(group) => {
          if (group.category === "create") return language.t("dialog.newProject.createGroup")
          if (group.category === "recent") return language.t("home.recentProjects")
          return language.t("command.project.open")
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
          if (!item || item.isExpander || item.isCollapser || item.isCreate) return

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
          if (path.isCreate) {
            if (creating()) return
            const resolved = resolveNewPath(filter(), home(), start() ?? "")
            if (!resolved) return
            setCreating(true)
            sdk.client.file
              .create({ directory: resolved.parent, path: resolved.name, type: "directory" })
              .then(() => resolve(resolved.full))
              .catch(() => {})
              .finally(() => setCreating(false))
            return
          }
          // Navigate into the clicked directory (same as Tab key)
          const value = displayPath(path.absolute, filter(), home())
          list?.setFilter(value.endsWith("/") ? value : value + "/")
          setSelectedPath(path.absolute)
        }}
      >
        {(item) => {
          if (item.isCreate) {
            const resolved = createMemo(() => resolveNewPath(filter(), home(), start() ?? ""))
            const display = createMemo(() => {
              const r = resolved()
              if (!r) return ""
              return `${tildeOf(r.parent, home()) || r.parent}/${r.name}`
            })
            return (
              <div class="w-full flex items-center gap-x-3 rounded-md">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center gap-2 text-14-regular min-w-0 grow">
                  <span class="text-text-strong whitespace-nowrap">{language.t("dialog.newProject.createFolder")}</span>
                  <span class="text-text-weak font-mono truncate min-w-0">{display()}</span>
                </div>
              </div>
            )
          }
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
          const isRecent = item.group === "recent"

          const removeBtn = (
            <Show when={isRecent}>
              <button
                type="button"
                class="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 text-text-weak hover:text-text-strong transition-opacity"
                onClick={(e) => {
                  e.stopPropagation()
                  setHidden("dirs", (prev) => [...prev, item.absolute])
                }}
                title="从最近项目中移除"
              >
                ×
              </button>
            </Show>
          )

          if (path === "~") {
            return (
              <div class="w-full flex items-center justify-between rounded-md group">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-14-regular min-w-0">
                    <span class="text-text-strong whitespace-nowrap">~</span>
                    <span class="text-text-weak whitespace-nowrap">/</span>
                  </div>
                </div>
                {removeBtn}
              </div>
            )
          }
          return (
            <div class="w-full flex items-center justify-between rounded-md group">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                    {getDirectory(path)}
                  </span>
                  <span class="text-text-strong whitespace-nowrap">{getFilename(path)}</span>
                  <span class="text-text-weak whitespace-nowrap">/</span>
                </div>
              </div>
              {removeBtn}
            </div>
          )
        }}
      </List>
      <Show when={selectedPath()}>
        <div class="flex items-center justify-between gap-3 px-4 py-3 border-t border-border-base">
          <span class="text-12-mono text-text-weak truncate flex-1">
            {displayPath(selectedPath()!, filter(), home())}
          </span>
          <Button size="small" onClick={() => resolve(selectedPath()!)}>
            {language.t("dialog.directory.select")}
          </Button>
        </div>
      </Show>
    </Dialog>
  )
}
