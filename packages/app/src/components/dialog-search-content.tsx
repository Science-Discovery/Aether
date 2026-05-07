import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import fuzzysort from "fuzzysort"
import type { ListRef } from "@opencode-ai/ui/list"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, startTransition } from "solid-js"
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

type Part = {
  text: string
  hit: boolean
}

type Result = {
  path: {
    text: string
  }
  line_number: number
  lines: {
    text: string
  }
  submatches: {
    start: number
    end: number
  }[]
}

type Ranked = {
  item: Entry
  score: number
}

const PAGE = 100
const WAIT = 50
const CHUNK = 200

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

const sort = (a: Ranked, b: Ranked) => {
  if (a.score !== b.score) return b.score - a.score
  return a.item.id.localeCompare(b.item.id)
}

const order = (a: Ranked, b: Ranked) => {
  if (a.score !== b.score) return a.score - b.score
  return b.item.id.localeCompare(a.item.id)
}

const sink = (heap: Ranked[], root: number) => {
  let i = root
  while (true) {
    const left = i * 2 + 1
    const right = left + 1
    let next = i
    if (left < heap.length && order(heap[left], heap[next]) < 0) next = left
    if (right < heap.length && order(heap[right], heap[next]) < 0) next = right
    if (next === i) return
    ;[heap[i], heap[next]] = [heap[next], heap[i]]
    i = next
  }
}

const rise = (heap: Ranked[], leaf: number) => {
  let i = leaf
  while (i > 0) {
    const parent = Math.floor((i - 1) / 2)
    if (order(heap[i], heap[parent]) >= 0) return
    ;[heap[i], heap[parent]] = [heap[parent], heap[i]]
    i = parent
  }
}

const push = (heap: Ranked[], item: Ranked, size: number) => {
  if (size <= 0) return
  if (heap.length < size) {
    heap.push(item)
    rise(heap, heap.length - 1)
    return
  }
  const last = heap[0]
  if (order(item, last) >= 0) return
  heap[0] = item
  sink(heap, 0)
}

const debug = () => {
  if (!import.meta.env.DEV) return false
  if (typeof window === "undefined") return false
  return window.localStorage?.getItem("aether:debug:search-content") === "1"
}

const log = (msg: string, data: Record<string, unknown>) => {
  if (!debug()) return
  console.debug("[search-content]", msg, data)
}

const same = (prev: Entry[], next: Ranked[]) => {
  if (prev.length !== next.length) return false
  return prev.every((item, i) => item.id === next[i]?.item.id)
}

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
  const [items, setItems] = createSignal<Entry[]>([])
  const [count, setCount] = createSignal(0)
  const [size, setSize] = createSignal(PAGE)
  const [loading, setLoading] = createSignal(false)
  let list: ListRef | undefined
  let abort: AbortController | undefined
  let all: Ranked[] = []
  let heap: Ranked[] = []
  let pool: Ranked[] = []
  let sorted: Ranked[] = []
  let dirty = false
  let tick: ReturnType<typeof setTimeout> | undefined
  const has = createMemo(() => !!inc().trim() || !!exc().trim() || cs() || word() || regex())
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const more = createMemo(() => size() < count())
  const empty = createMemo(() => {
    if (loading() && query().trim().length >= 2) return language.t("common.loading")
    return language.t("palette.empty")
  })

  const grow = () => {
    if (!more()) return
    const t0 = performance.now()
    const next = Math.min(size() + PAGE, count())
    setSize(next)
    if (dirty) {
      sorted = all.toSorted(sort)
      dirty = false
    }
    heap = sorted.slice(0, next)
    setItems(heap.map((item) => item.item))
    log("grow", {
      count: count(),
      size: next,
      ms: Math.round(performance.now() - t0),
    })
  }

  const scroll = () => {
    const el = list?.getScrollRef()
    if (!el || !more()) return
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 80) return
    grow()
  }

  const fill = () => {
    const el = list?.getScrollRef()
    if (!el || !more()) return
    if (el.scrollHeight > el.clientHeight + 80) return
    grow()
  }

  const stop = () => {
    pool = []
    if (!tick) return
    clearTimeout(tick)
    tick = undefined
  }

  const clear = () => {
    all = []
    heap = []
    sorted = []
    dirty = false
    stop()
  }

  const flush = () => {
    const next = pool.splice(0, CHUNK)
    if (next.length === 0) return
    const t0 = performance.now()
    if (tick) {
      clearTimeout(tick)
      tick = undefined
    }
    for (const item of next) {
      all.push(item)
      push(heap, item, size())
    }
    dirty = true
    setCount(all.length)
    const view = heap.toSorted(sort)
    const done = () => {
      log("flush", {
        batch: next.length,
        count: all.length,
        size: size(),
        pending: pool.length,
        ms: Math.round(performance.now() - t0),
      })
      if (pool.length > 0) {
        tick = setTimeout(flush, 0)
        return
      }
      queueMicrotask(fill)
    }
    if (same(items(), view)) {
      done()
      return
    }
    void startTransition(() => {
      setItems(view.map((item) => item.item))
    }).then(done)
  }

  const queue = (next: Ranked[]) => {
    pool.push(...next)
    if (count() === 0 && pool.length >= PAGE) {
      flush()
      return
    }
    if (tick) return
    tick = setTimeout(flush, WAIT)
  }

  const entry = (item: Result, pattern: string) => {
    const next = {
      id: `${item.path.text}:${item.line_number}:${item.lines.text}`,
      line: item.line_number,
      matches: item.submatches.map((part) => ({
        start: part.start,
        end: part.end,
      })),
      path: file.normalize(item.path.text),
      text: item.lines.text.trimEnd(),
    }
    const path = fuzzysort.single(pattern, fuzzysort.prepare(next.path))?.score ?? 0
    const text = fuzzysort.single(pattern, fuzzysort.prepare(next.text))?.score ?? 0
    return {
      item: next,
      score: Math.max(path, text),
    }
  }

  const open = (path: string, line: number) => {
    const tab = file.tab(path)
    file.setSelectedPaths(new Set<string>([path]))
    file.setSelectedLines(path, { start: line, end: line })
    tabs().open(tab)
    void file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    props.onOpenFile?.(path)
    tabs().setActive(tab)
    defer(() => void file.tree.reveal(path))
  }

  const search = async () => {
    const pattern = query().trim()
    const current = dir()
    abort?.abort()
    clear()
    setItems([])
    setCount(0)
    setSize(PAGE)

    if (pattern.length < 2 || !current) {
      setLoading(false)
      return
    }

    const ctl = new AbortController()
    abort = ctl
    setLoading(true)

    try {
      const result = await sdk.createClient({ directory: current, throwOnError: true }).find.textStream(
        {
          pattern,
          include: inc().trim() || undefined,
          exclude: exc().trim() || undefined,
          case: cs() ? "true" : "false",
          word: word() ? "true" : "false",
          regex: regex() ? "true" : "false",
        },
        {
          sseMaxRetryAttempts: 1,
          signal: ctl.signal,
        },
      )

      for await (const item of result.stream) {
        if (Array.isArray(item)) {
          queue(item.map((row) => entry(row, pattern)))
          continue
        }

        if ("count" in item) {
          flush()
          setLoading(false)
          return
        }

        throw new Error(item.message || "Search stream failed")
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return
      if (ctl.signal.aborted) return
      console.error(err)
    } finally {
      stop()
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

  createEffect(() => {
    items()
    queueMicrotask(fill)
  })

  onCleanup(() => {
    clear()
    abort?.abort()
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
        filterKeys={["path", "text"]}
        onFilter={setQuery}
        onSelect={(item) => {
          if (!item) return
          dialog.close()
          open(item.path, item.line)
        }}
      >
        {(item) => (
          <div class="w-full flex items-start justify-between rounded-md pl-1">
            <div class="flex items-start gap-x-3 grow min-w-0">
              <FileIcon node={{ path: item.path, type: "file" }} class="mt-0.5 shrink-0 size-4" />
              <div class="min-w-0">
                <div class="flex items-center text-14-regular min-w-0">
                  <span class="text-text-strong whitespace-nowrap">{getFilename(item.path)}</span>
                  <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                    {`  ${getDirectory(item.path)}:${item.line}`}
                  </span>
                </div>
                <Show when={item.text}>
                  <div class="truncate text-13-regular text-text-weak text-left">
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
        )}
      </List>
      <Show when={has()}>
        <div class="px-3 py-2 text-12-regular text-text-weak">
          {language.t("dialog.searchContent.advancedActive")}
        </div>
      </Show>
    </Dialog>
  )
}
