import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

interface DialogFileBrowserProps {
  title?: string
  multiple?: boolean
  allowCreate?: boolean
  onSelect: (result: string | string[] | null) => void
}

function normalizeDriveRoot(input: string) {
  const v = input.replaceAll("\\", "/").replace(/\/+/g, "/")
  if (/^[A-Za-z]:$/.test(v)) return v + "/"
  return v
}

function trimTrailing(input: string) {
  const v = normalizeDriveRoot(input)
  if (v === "/") return v
  if (/^[A-Za-z]:\/$/.test(v)) return v
  return v.replace(/\/+$/, "")
}

function parentOf(input: string) {
  const v = trimTrailing(input)
  if (v === "/") return v
  if (/^[A-Za-z]:\/$/.test(v)) return v
  const i = v.lastIndexOf("/")
  if (i <= 0) return "/"
  if (i === 2 && /^[A-Za-z]:/.test(v)) return v.slice(0, 3)
  return v.slice(0, i)
}

function getBreadcrumbs(path: string, home: string): Array<{ label: string; path: string }> {
  const h = trimTrailing(home)
  const p = trimTrailing(path)

  if (h && (p === h || p.startsWith(h + "/"))) {
    const rel = p.slice(h.length)
    const parts = rel.split("/").filter(Boolean)
    const crumbs: Array<{ label: string; path: string }> = [{ label: "~", path: h }]
    let current = h
    for (const part of parts) {
      current = current + "/" + part
      crumbs.push({ label: part, path: current })
    }
    return crumbs
  }

  const parts = p.split("/").filter(Boolean)
  const crumbs: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }]
  let current = ""
  for (const part of parts) {
    current = current + "/" + part
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}

export function DialogFileBrowser(props: DialogFileBrowserProps) {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const language = useLanguage()

  const missingBase = createMemo(() => !(sync.data.path.home || sync.data.path.directory))
  const [fallbackPath] = createResource(
    () => (missingBase() ? true : undefined),
    async () =>
      sdk.client.path
        .get()
        .then((x) => x.data)
        .catch(() => undefined),
    { initialValue: undefined },
  )

  const home = createMemo(() => sync.data.path.home || fallbackPath()?.home || "")
  const startDir = createMemo(() =>
    trimTrailing(
      sync.data.path.home ||
        sync.data.path.directory ||
        fallbackPath()?.home ||
        fallbackPath()?.directory ||
        "/",
    ),
  )

  const [currentPath, setCurrentPath] = createSignal<string | null>(null)
  const effectivePath = createMemo(() => currentPath() ?? startDir())

  const [showNewFolder, setShowNewFolder] = createSignal(false)
  const [newFolderName, setNewFolderName] = createSignal("")
  const [creating, setCreating] = createSignal(false)

  const [entries, { refetch }] = createResource(effectivePath, async (dir) => {
    const nodes = await sdk.client.file
      .list({ directory: dir, path: "" })
      .then((x) => x.data ?? [])
      .catch(() => [])
    return nodes
      .filter((n) => n.type === "directory")
      .map((n) => ({ name: n.name, absolute: trimTrailing(normalizeDriveRoot(n.absolute)) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  function navigate(path: string) {
    setCurrentPath(trimTrailing(path))
    setShowNewFolder(false)
    setNewFolderName("")
  }

  function selectCurrent() {
    const path = effectivePath()
    props.onSelect(props.multiple ? [path] : path)
    dialog.close()
  }

  async function createFolder() {
    const name = newFolderName().trim()
    if (!name) return
    setCreating(true)
    try {
      await sdk.client.file.create({
        directory: effectivePath(),
        path: name,
        type: "directory",
      })
      const newPath = trimTrailing(effectivePath()) + "/" + name
      setShowNewFolder(false)
      setNewFolderName("")
      navigate(newPath)
      refetch()
    } catch {
      // keep input open on error
    } finally {
      setCreating(false)
    }
  }

  const crumbs = createMemo(() => getBreadcrumbs(effectivePath(), home()))
  const isAtRoot = createMemo(() => {
    const p = effectivePath()
    return p === "/" || /^[A-Za-z]:\/$/.test(p)
  })

  const displayPath = createMemo(() => {
    const p = effectivePath()
    const h = home()
    if (h && (p === h || p.startsWith(h + "/"))) return "~" + p.slice(h.length)
    return p
  })

  return (
    <Dialog title={props.title ?? language.t("command.project.open")} size="large">
      {/* Breadcrumb navigation */}
      <div class="flex items-center gap-0.5 px-4 py-2 flex-wrap overflow-x-auto">
        <For each={crumbs()}>
          {(crumb, i) => (
            <>
              <Show when={i() > 0}>
                <Icon name="chevron-right" size="small" class="text-text-disabled shrink-0" />
              </Show>
              <button
                class="px-1 py-0.5 rounded text-12-regular transition-colors whitespace-nowrap"
                classList={{
                  "text-text-strong font-medium": i() === crumbs().length - 1,
                  "text-text-weak hover:text-text-strong hover:bg-bg-hover-base": i() < crumbs().length - 1,
                }}
                onClick={() => navigate(crumb.path)}
              >
                {crumb.label}
              </button>
            </>
          )}
        </For>
      </div>

      {/* Directory listing */}
      <div class="overflow-y-auto border-t border-border-base" style={{ "min-height": "240px", "max-height": "320px" }}>
        <Show when={entries.loading}>
          <div class="flex items-center justify-center py-8 text-text-weak text-14-regular">
            {language.t("common.loading")}
          </div>
        </Show>
        <Show when={!entries.loading}>
          {/* Parent directory row */}
          <Show when={!isAtRoot()}>
            <button
              class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover-base text-left transition-colors"
              onClick={() => navigate(parentOf(effectivePath()))}
            >
              <Icon name="arrow-left" size="small" class="size-4 shrink-0 text-icon-base" />
              <span class="text-14-regular text-text-weak">..</span>
            </button>
          </Show>

          {/* Subdirectories */}
          <For each={entries()}>
            {(entry) => (
              <button
                class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover-base cursor-pointer text-left transition-colors"
                onClick={() => navigate(entry.absolute)}
              >
                <FileIcon node={{ path: entry.absolute, type: "directory" }} class="size-4 shrink-0" />
                <span class="text-14-regular text-text-strong flex-1">{entry.name}</span>
                <Icon name="chevron-right" size="small" class="text-icon-base shrink-0" />
              </button>
            )}
          </For>

          <Show when={!isAtRoot() && entries()?.length === 0}>
            <div class="flex items-center justify-center py-6 text-text-weak text-14-regular">
              {language.t("dialog.fileBrowser.empty")}
            </div>
          </Show>
        </Show>
      </div>

      {/* New folder input */}
      <Show when={showNewFolder()}>
        <div class="flex items-center gap-2 px-4 py-2 border-t border-border-base">
          <Icon name="folder" size="small" class="text-icon-base shrink-0" />
          <input
            class="flex-1 bg-transparent text-14-regular text-text-strong outline-none placeholder:text-text-weak"
            placeholder={language.t("dialog.fileBrowser.newFolderPlaceholder")}
            value={newFolderName()}
            autofocus
            onInput={(e) => setNewFolderName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createFolder()
              if (e.key === "Escape") {
                setShowNewFolder(false)
                setNewFolderName("")
              }
            }}
          />
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              setShowNewFolder(false)
              setNewFolderName("")
            }}
          >
            {language.t("common.cancel")}
          </Button>
          <Button size="small" onClick={createFolder} disabled={!newFolderName().trim() || creating()}>
            {language.t("dialog.fileBrowser.createFolder")}
          </Button>
        </div>
      </Show>

      {/* Footer */}
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-t border-border-base">
        <span class="text-12-mono text-text-weak truncate flex-1">{displayPath()}</span>
        <div class="flex items-center gap-2 shrink-0">
          <Show when={props.allowCreate && !showNewFolder()}>
            <Button
              size="small"
              variant="ghost"
              icon="plus-small"
              onClick={() => setShowNewFolder(true)}
            >
              {language.t("dialog.fileBrowser.newFolder")}
            </Button>
          </Show>
          <Button size="small" onClick={selectCurrent}>
            {language.t("dialog.fileBrowser.select")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
