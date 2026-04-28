import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useFile } from "@/context/file"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
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

export function DialogSearchContent(props: { onOpenFile?: (path: string) => void }) {
  const dialog = useDialog()
  const file = useFile()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const layout = useLayout()
  const { params, tabs, view } = useSessionLayout()
  let list: ListRef | undefined
  const [query, setQuery] = createSignal("")
  const [adv, setAdv] = createSignal(false)
  const [inc, setInc] = createSignal("")
  const [exc, setExc] = createSignal("")
  const [cs, setCs] = createSignal(false)
  const [word, setWord] = createSignal(false)
  const [regex, setRegex] = createSignal(false)
  let abort: AbortController | undefined
  const has = createMemo(() => !!inc().trim() || !!exc().trim() || cs() || word() || regex())
  const dir = createMemo(() => decode64(params.dir) ?? "")

  const items = async (text: string) => {
    const pattern = text.trim()
    if (pattern.length < 2) return [] as Entry[]
    const current = dir()
    if (!current) return [] as Entry[]
    abort?.abort()
    const ctl = new AbortController()
    abort = ctl
    return globalSDK
      .createClient({
        directory: current,
        throwOnError: true,
      })
      .find.text({
        pattern,
        include: inc(),
        exclude: exc(),
        case: cs() ? "true" : "false",
        word: word() ? "true" : "false",
        regex: regex() ? "true" : "false",
      }, {
        signal: ctl.signal,
      })
      .then((x) => (x.data ?? []).map((item) => ({
        id: `${item.path.text}:${item.line_number}:${item.lines.text}`,
        line: item.line_number,
        matches: item.submatches.map((part) => ({
          start: part.start,
          end: part.end,
        })),
        path: file.normalize(item.path.text),
        text: item.lines.text.trimEnd(),
      })))
      .then((list) =>
      list.map((item) => ({
        id: `${item.path}:${item.line}:${item.text}`,
        line: item.line,
        matches: item.matches,
        path: item.path,
        text: item.text,
      })),
      )
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return []
        throw err
      })
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

  createEffect(() => {
    inc()
    exc()
    cs()
    word()
    regex()
    const text = query()
    if (text.length < 2) return
    list?.setFilter(text)
  })

  onCleanup(() => abort?.abort())

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
        emptyMessage={language.t("palette.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(item) => item.id}
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
