import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import type { ListRef } from "@opencode-ai/ui/list"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, startTransition } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"

type Match = {
  start: number
  end: number
}

type Entry = {
  id: string
  line: number
  matches: Match[]
  path: string
  text: string
}

type Group = {
  path: string
  items: Entry[]
}

type Row =
  | {
      id: string
      kind: "group"
      path: string
      total: number
    }
  | (Entry & {
      kind: "item"
    })

type Part = {
  text: string
  hit: boolean
}

type Result = {
  path: {
    text: string
  }
  items: {
    line_number: number
    lines: {
      text: string
    }
    submatches: {
      start: number
      end: number
    }[]
  }[]
}

const PAGE = 10

const defer = (run: () => void) => {
  requestAnimationFrame(() => requestAnimationFrame(run))
}

const parts = (text: string, matches: Match[]) => {
  if (matches.length === 0) return [{ text, hit: false }] satisfies Part[]
  const out: Part[] = []
  let pos = 0

  for (const match of matches) {
    if (match.start > pos) out.push({ text: text.slice(pos, match.start), hit: false })
    out.push({ text: text.slice(match.start, match.end), hit: true })
    pos = match.end
  }

  if (pos < text.length) out.push({ text: text.slice(pos), hit: false })
  return out
}

const rows = (groups: Group[], fold: Record<string, boolean>) =>
  groups.flatMap((item) => {
    const out: Row[] = [
      {
        id: `group:${item.path}`,
        kind: "group",
        path: item.path,
        total: item.items.length,
      },
    ]
    if (fold[item.path] === false) return out
    return out.concat(
      item.items.map((part) => ({
        ...part,
        kind: "item" as const,
      })),
    )
  })

const group = (file: ReturnType<typeof useFile>, item: Result) => ({
  path: file.normalize(item.path.text),
  items: item.items.map((part) => ({
    id: `content:${file.normalize(item.path.text)}:${part.line_number}:${part.lines.text}`,
    line: part.line_number,
    matches: part.submatches.map((hit) => ({
      start: hit.start,
      end: hit.end,
    })),
    path: file.normalize(item.path.text),
    text: part.lines.text.trimEnd(),
  })),
}) satisfies Group

const same = (prev: Row[], next: Row[]) => {
  if (prev.length !== next.length) return false
  return prev.every((item, i) => item.id === next[i]?.id)
}

const rowGroup = (item: Extract<Row, { kind: "group" }>, fold: Record<string, boolean>) => (
  <div class="w-full flex items-start gap-x-3 rounded-md px-1 py-1.5">
    <div class="mt-0.5 shrink-0 size-4 flex items-center justify-center text-text-dim">
      <Icon name={fold[item.path] === false ? "chevron-right" : "chevron-down"} size="small" />
    </div>
    <FileIcon node={{ path: item.path, type: "file" }} class="mt-0.5 shrink-0 size-4" />
    <div class="min-w-0">
      <div class="flex items-center gap-x-2 min-w-0">
        <span class="text-14-medium text-text-strong whitespace-nowrap">{getFilename(item.path)}</span>
        <span class="text-12-regular text-text-dim shrink-0">{item.total}</span>
      </div>
      <div class="truncate text-12-regular text-text-weak text-left">{getDirectory(item.path)}</div>
    </div>
  </div>
)

const rowItem = (item: Extract<Row, { kind: "item" }>) => (
  <div class="w-full flex items-start justify-between rounded-md pl-8">
    <div class="min-w-0">
      <div class="flex items-center gap-x-2 text-13-regular min-w-0">
        <span class="text-text-weak whitespace-nowrap shrink-0">{item.line}</span>
        <Show when={item.text}>
          <div class="truncate text-text-weak text-left">
            <For each={parts(item.text, item.matches)}>
              {(part) => (
                <span
                  classList={{
                    "rounded-sm bg-surface-warning-base text-text-strong": part.hit,
                  }}
                >
                  {part.text}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  </div>
)

export function DialogSearchContent(props: { onOpenFile?: (path: string) => void }) {
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const layout = useLayout()
  const sdk = useSDK()
  const { params, tabs, view } = useSessionLayout()
  const [query, setQuery] = createSignal("")
  const [adv, setAdv] = createSignal(false)
  const [inc, setInc] = createSignal("")
  const [exc, setExc] = createSignal("")
  const [cs, setCs] = createSignal(false)
  const [word, setWord] = createSignal(false)
  const [regex, setRegex] = createSignal(false)
  const [items, setItems] = createSignal<Row[]>([])
  const [loading, setLoading] = createSignal(false)
  const [fold, setFold] = createStore<Record<string, boolean>>({})
  let list: ListRef | undefined
  let abort: AbortController | undefined
  let sid: string | undefined
  let cursor = 0
  let done = true
  let next = false
  let all: Group[] = []
  const has = createMemo(() => !!inc().trim() || !!exc().trim() || cs() || word() || regex())
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const empty = createMemo(() => {
    if (loading() && query().trim().length >= 2) return language.t("common.loading")
    return language.t("palette.empty")
  })

  const sync = () => setItems(rows(all, fold))

  const scroll = () => {
    const el = list?.getScrollRef()
    if (!el || done || next) return
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 80) return
    void load()
  }

  const clear = () => {
    all = []
    sid = undefined
    cursor = 0
    done = true
    next = false
    setFold(reconcile({}))
  }

  const merge = (part: Group[]) => {
    if (part.length === 0) return
    all.push(...part)
    for (const item of part) {
      if (fold[item.path] === undefined) setFold(item.path, true)
    }
    const view = rows(all, fold)
    if (same(items(), view)) return
    void startTransition(() => {
      setItems(view)
    })
  }

  const drop = async () => {
    const id = sid
    sid = undefined
    if (!id) return
    try {
      await sdk.createClient({ directory: dir(), throwOnError: true }).find.contentSessionDelete({ sessionID: id })
    } catch {}
  }

  const reveal = (path: string, line: number) => {
    const tab = file.tab(path)
    file.setSelectedPaths(new Set<string>([path]))
    file.setSelectedLines(path, { start: line, end: line })
    file.requestRevealLine(path, line)
    tabs().open(tab)
    void file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    props.onOpenFile?.(path)
    tabs().setActive(tab)
    defer(() => void file.tree.reveal(path))
  }

  const toggle = (path: string) => {
    setFold(path, (value) => (value === false ? true : false))
    sync()
  }

  const load = async () => {
    if (!sid || done || next) return
    next = true
    try {
      const result = await sdk
        .createClient({ directory: dir(), throwOnError: true })
        .find.contentSessionNext({ sessionID: sid, cursor, limit: PAGE }, { signal: abort?.signal })
      const data = result.data
      if (!data) throw new Error("Search session page missing data")
      cursor = data.cursor
      done = data.done
      merge(data.items.map((item) => group(file, item)))
    } finally {
      next = false
    }
  }

  const search = async () => {
    const pattern = query().trim()
    const current = dir()
    abort?.abort()
    await drop()
    clear()
    setItems([])

    if (pattern.length < 2 || !current) {
      setLoading(false)
      return
    }

    const ctl = new AbortController()
    abort = ctl
    setLoading(true)

    try {
      const result = await sdk.createClient({ directory: current, throwOnError: true }).find.contentSessionCreate(
        {
          pattern,
          include: inc().trim() || undefined,
          exclude: exc().trim() || undefined,
          case: cs(),
          word: word(),
          regex: regex(),
          limit: PAGE,
        },
        {
          signal: ctl.signal,
        },
      )
      const data = result.data
      if (!data) throw new Error("Search session create missing data")
      sid = data.session_id
      cursor = data.cursor
      done = data.done
      merge(data.items.map((item) => group(file, item)))
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return
      if (ctl.signal.aborted) return
      console.error(err)
    } finally {
      if (abort === ctl) abort = undefined
      setLoading(false)
    }
  }
  createEffect(() => {
    query()
    inc()
    exc()
    cs()
    word()
    regex()
    void search()
  })

  createEffect(() => {
    const el = list?.getScrollRef()
    if (!el) return
    el.addEventListener("scroll", scroll, { passive: true })
    onCleanup(() => el.removeEventListener("scroll", scroll))
  })
  onCleanup(() => {
    clear()
    abort?.abort()
    void drop()
  })

  return (
    <Dialog class="pt-3 pb-0 !max-h-[480px]" transition>
      <Show when={adv()}>
        <div class="px-3 pb-3">
          <div class="rounded-md border border-border-weak-base bg-surface-panel p-3">
            <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
              <TextField
                label={language.t("dialog.searchContent.include")}
                placeholder={language.t("dialog.searchContent.include.placeholder")}
                value={inc()}
                onChange={setInc}
              />
              <TextField
                label={language.t("dialog.searchContent.exclude")}
                placeholder={language.t("dialog.searchContent.exclude.placeholder")}
                value={exc()}
                onChange={setExc}
              />
            </div>
            <div class="mt-3 flex flex-wrap gap-4">
              <Switch checked={cs()} onChange={setCs}>
                {language.t("dialog.searchContent.case")}
              </Switch>
              <Switch checked={word()} onChange={setWord}>
                {language.t("dialog.searchContent.word")}
              </Switch>
              <Switch checked={regex()} onChange={setRegex}>
                {language.t("dialog.searchContent.regex")}
              </Switch>
            </div>
          </div>
        </div>
      </Show>
      <List
        ref={(value) => {
          list = value
        }}
        search={{
          placeholder: language.t("dialog.searchContent.placeholder"),
          autofocus: true,
          hideIcon: true,
          action: (
            <IconButton
              icon="sliders"
              variant="ghost"
              onClick={() => setAdv((value) => !value)}
              aria-label={language.t("dialog.searchContent.advanced")}
            />
          ),
        }}
        emptyMessage={empty()}
        items={items()}
        key={(item) => item.id}
        filterMode="none"
        onFilter={setQuery}
        onSelect={(item) => {
          if (!item) return
          if (item.kind === "group") {
            toggle(item.path)
            return
          }
          dialog.close()
          reveal(item.path, item.line)
        }}
      >
        {(item) => (item.kind === "group" ? rowGroup(item, fold) : rowItem(item))}
      </List>
      <Show when={has()}>
        <div class="px-3 py-2 text-12-regular text-text-weak">
          {language.t("dialog.searchContent.advancedActive")}
        </div>
      </Show>
    </Dialog>
  )
}
