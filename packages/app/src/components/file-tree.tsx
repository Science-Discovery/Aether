import { showToast } from "@opencode-ai/ui/toast"
import { useFile } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  untrack,
  type ComponentProps,
  type JSXElement,
  type ParentProps,
} from "solid-js"
import { TruncateMiddle } from "@/components/truncate-middle"
import { Dynamic } from "solid-js/web"
import type { FileNode } from "@opencode-ai/sdk/v2"

const MAX_DEPTH = 128

function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

type Kind = "add" | "del" | "mix"

type Filter = {
  files: Set<string>
  dirs: Set<string>
}

export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }) {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}) {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

export function dirsToExpand(input: {
  level: number
  filter?: { dirs: Set<string> }
  expanded: (dir: string) => boolean
}) {
  if (input.level !== 0) return []
  if (!input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

const visibleKind = (node: FileNode, kinds?: ReadonlyMap<string, Kind>, marks?: Set<string>) => {
  const kind = kinds?.get(node.path)
  if (!kind) return
  if (!marks?.has(node.path)) return
  return kind
}

const buildDragImage = (target: HTMLElement) => {
  const icon = target.querySelector('[data-component="file-icon"]') ?? target.querySelector("svg")
  const text = target.querySelector("span")
  if (!icon || !text) return

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"
  image.innerHTML = (icon as SVGElement).outerHTML + (text as HTMLSpanElement).outerHTML
  return image
}

const withFileDragImage = (event: DragEvent) => {
  const image = buildDragImage(event.currentTarget as HTMLElement)
  if (!image) return
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      node: FileNode
      level: number
      active?: string
      selected?: boolean
      selectedPaths?: Set<string>
      nodeClass?: string
      draggable: boolean
      kinds?: ReadonlyMap<string, Kind>
      marks?: Set<string>
      as?: "div" | "button"
    },
) => {
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "selected",
    "selectedPaths",
    "nodeClass",
    "draggable",
    "kinds",
    "marks",
    "as",
    "children",
    "class",
    "classList",
  ])
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const active = () => !!kind() && !local.node.ignored
  const color = () => {
    const value = kind()
    if (!value) return
    return kindTextColor(value)
  }

  return (
    <Dynamic
      component={local.as ?? "div"}
      classList={{
        "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
        "bg-surface-base-active": local.node.path === local.active,
        "bg-surface-raised-base-hover": !!local.selected && local.node.path !== local.active,
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
        [local.nodeClass ?? ""]: !!local.nodeClass,
      }}
      style={`padding-left: ${Math.max(0, 8 + local.level * 12 - (local.node.type === "file" ? 24 : 4))}px`}
      draggable={local.draggable}
      onDragStart={(event: DragEvent) => {
        if (!local.draggable) return
        const sel = local.selectedPaths
        if (sel && sel.size > 1 && sel.has(local.node.path)) {
          // Drag all selected files
          const paths = [...sel]
          event.dataTransfer?.setData("text/plain", paths.map((p) => `file:${p}`).join("\n"))
          event.dataTransfer?.setData("text/uri-list", paths.map(pathToFileUrl).join("\n"))
          event.dataTransfer?.setData("application/x-filetree-multi", JSON.stringify(paths))
        } else {
          event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
          event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
        }
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove"
        withFileDragImage(event)
      }}
      {...rest}
    >
      {local.children}
      <TruncateMiddle
        text={local.node.name}
        class={[
          "flex-1 min-w-0 text-12-medium whitespace-nowrap overflow-hidden relative",
          local.node.ignored ? "text-text-weaker" : !active() ? "text-text-weak" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={active() ? color() : undefined}
      />
      {(() => {
        const value = kind()
        if (!value) return null
        if (local.node.type === "file") {
          return (
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value)}>
              {kindLabel(value)}
            </span>
          )
        }
        return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value)} />
      })()}
    </Dynamic>
  )
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  selectedPaths?: Set<string>
  onFileClick?: (file: FileNode, event?: MouseEvent) => void
  onFileCreate?: (dir: string, type: "file" | "directory") => void
  onFileDelete?: (node: FileNode) => void
  onFileRename?: (node: FileNode) => void
  onFileDownload?: (node: FileNode) => void
  /** Bulk operations for multi-select */
  onMultiDelete?: (paths: string[]) => void
  onMultiCopyPaths?: (paths: string[]) => void
  onMultiDownload?: (paths: string[]) => void
  onMultiMove?: (paths: string[], targetDir: string) => void
  onMultiCopy?: (paths: string[]) => void
  onMultiCut?: (paths: string[]) => void
  /** Drag-drop into folders */
  onFileDrop?: (paths: string[], targetDir: string) => void
  /** External file/folder uploads into folders */
  onUploadDrop?: (event: DragEvent, targetDir: string) => void
  /** PDF 转 Markdown（单文件或批量） */
  onPdfConvert?: (paths: string[]) => void
  /** Markdown 翻译为中文（单文件或批量） */
  onTranslateMarkdown?: (paths: string[]) => void

  _filter?: Filter
  _marks?: Set<string>
  _deeps?: Map<string, number>
  _kinds?: ReadonlyMap<string, Kind>
  _chain?: readonly string[]
}) {
  const file = useFile()
  const platform = usePlatform()
  const sdk = useSDK()
  const { params } = useSessionLayout()
  const level = props.level ?? 0
  const draggable = () => props.draggable ?? true

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]

  const filter = createMemo(() => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      const parents = parts.slice(0, -1)
      for (const [idx] of parents.entries()) {
        const dir = parents.slice(0, idx + 1).join("/")
        if (dir) dirs.add(dir)
      }
    }

    return { files, dirs }
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const out = new Map<string, number>()

    const root = props.path
    if (!(file.tree.state(root)?.expanded ?? false)) return out

    const seen = new Set<string>()
    const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

    const push = (dir: string, lvl: number) => {
      const id = key(dir)
      if (seen.has(id)) return
      seen.add(id)

      const kids = file.tree
        .children(dir)
        .filter((node) => node.type === "directory" && (file.tree.state(node.path)?.expanded ?? false))
        .map((node) => node.path)

      stack.push({ dir, lvl, i: 0, kids, max: lvl })
    }

    push(root, level - 1)

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!

      if (top.i < top.kids.length) {
        const next = top.kids[top.i]!
        top.i++
        push(next, top.lvl + 1)
        continue
      }

      out.set(top.dir, top.max)
      stack.pop()

      const parent = stack[stack.length - 1]
      if (!parent) continue
      parent.max = Math.max(parent.max, top.max)
    }

    return out
  })

  createEffect(() => {
    const current = filter()
    const dirs = dirsToExpand({
      level,
      filter: current,
      expanded: (dir) => untrack(() => file.tree.state(dir)?.expanded) ?? false,
    })
    for (const dir of dirs) file.tree.expand(dir)
  })

  createEffect(
    on(
      () => props.path,
      (path) => {
        const dir = untrack(() => file.tree.state(path))
        if (!shouldListRoot({ level, dir })) return
        void file.tree.list(path)
      },
      { defer: false },
    ),
  )

  const nodes = createMemo(() => {
    const nodes = file.tree.children(props.path)
    const current = filter()
    if (!current) return nodes

    const parent = (path: string) => {
      const idx = path.lastIndexOf("/")
      if (idx === -1) return ""
      return path.slice(0, idx)
    }

    const leaf = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? path : path.slice(idx + 1)
    }

    const out = nodes.filter((node) => {
      if (node.type === "file") return current.files.has(node.path)
      return current.dirs.has(node.path)
    })

    const seen = new Set(out.map((node) => node.path))

    for (const dir of current.dirs) {
      if (parent(dir) !== props.path) continue
      if (seen.has(dir)) continue
      out.push({
        name: leaf(dir),
        path: dir,
        absolute: dir,
        type: "directory",
        ignored: false,
      })
      seen.add(dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path) continue
      if (seen.has(item)) continue
      out.push({
        name: leaf(item),
        path: item,
        absolute: item,
        type: "file",
        ignored: false,
      })
      seen.add(item)
    }

    out.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return out
  })

  return (
    <div data-component="filetree" class={`flex flex-col gap-0.5 ${props.class ?? ""}`}>
      <For each={nodes()}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const deep = () => deeps().get(node.path) ?? -1
          const kind = () => visibleKind(node, kinds(), marks())
          const active = () => !!kind() && !node.ignored

          const isMultiSelected = () => {
            const sel = props.selectedPaths
            return sel && sel.size > 1 && sel.has(node.path)
          }

          const isPdf = () => node.type === "file" && node.name.toLowerCase().endsWith(".pdf")
          const isMarkdown = () => node.type === "file" && /\.(md|markdown)$/i.test(node.name)

          const allSelectedArePdf = () => {
            const sel = props.selectedPaths
            if (!sel || sel.size < 2) return false
            for (const p of sel) {
              if (!p.toLowerCase().endsWith(".pdf")) return false
            }
            return true
          }

          const allSelectedAreMarkdown = () => {
            const sel = props.selectedPaths
            if (!sel || sel.size < 2) return false
            for (const p of sel) {
              if (!/\.(md|markdown)$/i.test(p)) return false
            }
            return true
          }

          const multiContextMenu = (trigger: () => JSXElement) => (
            <ContextMenu>
              <ContextMenu.Trigger as="div" class="w-full">
                {trigger()}
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content>
                  <ContextMenu.Item
                    onSelect={() => {
                      const paths = [...(props.selectedPaths ?? [])]
                      props.onMultiCopy?.(paths)
                    }}
                  >
                    <ContextMenu.ItemLabel>复制（{props.selectedPaths?.size ?? 0} 项）</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    onSelect={() => {
                      const paths = [...(props.selectedPaths ?? [])]
                      props.onMultiCut?.(paths)
                    }}
                  >
                    <ContextMenu.ItemLabel>剪切（{props.selectedPaths?.size ?? 0} 项）</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    onSelect={() => {
                      const paths = [...(props.selectedPaths ?? [])]
                      navigator.clipboard.writeText(paths.join("\n"))
                      showToast({ variant: "success", title: `已复制 ${paths.length} 个路径` })
                    }}
                  >
                    <ContextMenu.ItemLabel>复制路径（{props.selectedPaths?.size ?? 0} 项）</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    onSelect={() => {
                      const paths = [...(props.selectedPaths ?? [])]
                      props.onMultiDownload?.(paths)
                    }}
                  >
                    <ContextMenu.ItemLabel>下载（{props.selectedPaths?.size ?? 0} 项）</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <Show when={allSelectedArePdf() && props.onPdfConvert}>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                      onSelect={() => {
                        const paths = [...(props.selectedPaths ?? [])]
                        props.onPdfConvert?.(paths)
                      }}
                    >
                      <ContextMenu.ItemLabel>
                        转换为 Markdown（{props.selectedPaths?.size ?? 0} 项）
                      </ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                  </Show>
                  <Show when={allSelectedAreMarkdown() && props.onTranslateMarkdown}>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                      onSelect={() => {
                        const paths = [...(props.selectedPaths ?? [])]
                        props.onTranslateMarkdown?.(paths)
                      }}
                    >
                      <ContextMenu.ItemLabel>翻译为中文（{props.selectedPaths?.size ?? 0} 项）</ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                  </Show>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    onSelect={() => {
                      const paths = [...(props.selectedPaths ?? [])]
                      props.onMultiDelete?.(paths)
                    }}
                    class="text-red-500 focus:text-red-500"
                  >
                    <ContextMenu.ItemLabel>删除（{props.selectedPaths?.size ?? 0} 项）</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu>
          )

          const contextMenu = (trigger: () => JSXElement) => (
            <ContextMenu>
              <ContextMenu.Trigger as="div" class="w-full">
                {trigger()}
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content>
                  {node.type === "directory" && (
                    <>
                      <ContextMenu.Item onSelect={() => props.onFileCreate?.(node.path, "file")}>
                        <ContextMenu.ItemLabel>新建文件</ContextMenu.ItemLabel>
                      </ContextMenu.Item>
                      <ContextMenu.Item onSelect={() => props.onFileCreate?.(node.path, "directory")}>
                        <ContextMenu.ItemLabel>新建文件夹</ContextMenu.ItemLabel>
                      </ContextMenu.Item>
                      <ContextMenu.Separator />
                    </>
                  )}
                  <ContextMenu.Item
                    onSelect={() => {
                      navigator.clipboard.writeText(node.path)
                      showToast({ variant: "success", title: "已复制相对路径" })
                    }}
                  >
                    <ContextMenu.ItemLabel>复制相对路径</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    onSelect={() => {
                      navigator.clipboard.writeText(node.absolute)
                      showToast({ variant: "success", title: "已复制路径" })
                    }}
                  >
                    <ContextMenu.ItemLabel>复制路径</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item onSelect={() => props.onFileDownload?.(node)}>
                    <ContextMenu.ItemLabel>下载</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    onSelect={async () => {
                      try {
                        await sdk.client.file.open({
                          path: node.absolute,
                        })

                        showToast({
                          variant: "success",
                          title: "已用默认应用打开",
                        })
                      } catch (err) {
                        console.error("Failed to open file:", err)

                        showToast({
                          variant: "error",
                          title: "打开文件失败",
                          description: "请尝试手动打开",
                        })
                      }
                    }}
                  >
                    <ContextMenu.ItemLabel>打开</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <Show when={platform.platform === "web"}>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                      onSelect={async () => {
                        try {
                          await sdk.client.file.openInExplorer({
                            path: node.absolute,
                          })

                          showToast({
                            variant: "success",
                            title: "已在文件资源管理器中显示",
                          })
                        } catch (err) {
                          console.error("Failed to open in explorer:", err)

                          await navigator.clipboard.writeText(node.absolute)
                          showToast({
                            variant: "error",
                            title: "打开失败",
                            description: "已复制路径到剪贴板，请手动打开",
                          })
                        }
                      }}
                    >
                      <ContextMenu.ItemLabel>在文件资源管理器中显示</ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                  </Show>
                  <Show when={isPdf() && props.onPdfConvert}>
                    <ContextMenu.Separator />
                    <ContextMenu.Item onSelect={() => props.onPdfConvert?.([node.path])}>
                      <ContextMenu.ItemLabel>转换为 Markdown</ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                  </Show>
                  <Show when={isMarkdown() && props.onTranslateMarkdown}>
                    <ContextMenu.Separator />
                    <ContextMenu.Item onSelect={() => props.onTranslateMarkdown?.([node.path])}>
                      <ContextMenu.ItemLabel>翻译为中文</ContextMenu.ItemLabel>
                    </ContextMenu.Item>
                  </Show>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    onSelect={async () => {
                      try {
                        const res = await sdk.client.file.addToGitignore({
                          path: node.path,
                          type: node.type,
                        })
                        if (res.data?.alreadyExists) {
                          showToast({
                            variant: "default",
                            title: "已在 .gitignore 中",
                            description: `路径 "${node.path}" 已存在，无需重复添加`,
                          })
                        } else if (res.data?.created) {
                          showToast({
                            variant: "success",
                            title: "已创建 .gitignore 并添加",
                            description: `"${node.path}" 已添加到新建的 .gitignore`,
                          })
                        } else {
                          showToast({
                            variant: "success",
                            title: "已添加到 .gitignore",
                          })
                        }
                      } catch (err) {
                        console.error("Failed to add to .gitignore:", err)
                        showToast({
                          variant: "error",
                          title: "添加失败",
                          description: "无法写入 .gitignore",
                        })
                      }
                    }}
                  >
                    <ContextMenu.ItemLabel>忽略变更</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Item onSelect={() => props.onFileRename?.(node)}>
                    <ContextMenu.ItemLabel>重命名</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onSelect={() => props.onFileDelete?.(node)} class="text-red-500 focus:text-red-500">
                    <ContextMenu.ItemLabel>删除</ContextMenu.ItemLabel>
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu>
          )

          const wrapContextMenu = (trigger: () => JSXElement) =>
            isMultiSelected() ? multiContextMenu(trigger) : contextMenu(trigger)

          const [dragOver, setDragOver] = createSignal(false)
          let dragCounter = 0

          const handleDirDragEnter = (e: DragEvent) => {
            if (!e.dataTransfer) return
            if (!e.dataTransfer.types.includes("text/plain") && !e.dataTransfer.types.includes("Files")) return
            e.preventDefault()
            dragCounter++
            setDragOver(true)
          }
          const handleDirDragLeave = () => {
            dragCounter--
            if (dragCounter <= 0) {
              dragCounter = 0
              setDragOver(false)
            }
          }
          const handleDirDragOver = (e: DragEvent) => {
            if (!e.dataTransfer) return
            if (!e.dataTransfer.types.includes("text/plain") && !e.dataTransfer.types.includes("Files")) return
            e.preventDefault()
            e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") ? "copy" : "move"
          }
          const handleDirDrop = (e: DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            dragCounter = 0
            setDragOver(false)
            if (e.dataTransfer?.types.includes("Files")) {
              props.onUploadDrop?.(e, node.path)
              return
            }
            const multi = e.dataTransfer?.getData("application/x-filetree-multi")
            if (multi) {
              try {
                const paths = JSON.parse(multi) as string[]
                const filtered = paths.filter((p) => {
                  const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""
                  return parent !== node.path && p !== node.path
                })
                if (filtered.length > 0) props.onFileDrop?.(filtered, node.path)
              } catch {
                /* ignore */
              }
              return
            }
            const plain = e.dataTransfer?.getData("text/plain")
            if (plain?.startsWith("file:")) {
              const filePath = plain.slice("file:".length)
              const parent = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ""
              if (parent !== node.path && filePath !== node.path) {
                props.onFileDrop?.([filePath], node.path)
              }
            }
          }

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                {wrapContextMenu(() => (
                  <Collapsible
                    variant="ghost"
                    class="w-full"
                    data-scope="filetree"
                    forceMount={false}
                    open={expanded()}
                    onOpenChange={(open) => (open ? file.tree.expand(node.path) : file.tree.collapse(node.path))}
                  >
                    <div
                      onDragEnter={handleDirDragEnter}
                      onDragLeave={handleDirDragLeave}
                      onDragOver={handleDirDragOver}
                      onDrop={handleDirDrop}
                      classList={{
                        "rounded-md": true,
                        "outline outline-2 outline-blue-400 bg-blue-400/10": dragOver(),
                      }}
                      onClick={(e: MouseEvent) => {
                        if (e.metaKey || e.ctrlKey) {
                          e.preventDefault()
                          e.stopPropagation()
                          props.onFileClick?.(node, e)
                        }
                      }}
                    >
                      <Collapsible.Trigger>
                        <FileTreeNode
                          node={node}
                          level={level}
                          active={props.active}
                          selected={props.selectedPaths?.has(node.path)}
                          selectedPaths={props.selectedPaths}
                          nodeClass={props.nodeClass}
                          draggable={draggable()}
                          kinds={kinds()}
                          marks={marks()}
                        >
                          <div class="size-4 flex items-center justify-center text-icon-weak">
                            <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                          </div>
                        </FileTreeNode>
                        <Show when={node.symlinkTarget}>
                          <Icon
                            name="link"
                            size="small"
                            class="size-3.5 text-text-weak ml-1 flex-shrink-0 align-middle"
                          />
                        </Show>
                      </Collapsible.Trigger>
                    </div>
                    <Collapsible.Content class="relative pt-0.5">
                      <div
                        classList={{
                          "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                          "group-hover/filetree:opacity-100": expanded() && deep() === level,
                          "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                        }}
                        style={`left: ${Math.max(0, 8 + level * 12 - 4) + 8}px`}
                      />
                      <Show
                        when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                        fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
                      >
                        <FileTree
                          path={node.path}
                          level={level + 1}
                          allowed={props.allowed}
                          modified={props.modified}
                          kinds={props.kinds}
                          active={props.active}
                          draggable={props.draggable}
                          selectedPaths={props.selectedPaths}
                          onFileClick={props.onFileClick}
                          onFileCreate={props.onFileCreate}
                          onFileDelete={props.onFileDelete}
                          onFileRename={props.onFileRename}
                          onFileDownload={props.onFileDownload}
                          onMultiDelete={props.onMultiDelete}
                          onMultiCopyPaths={props.onMultiCopyPaths}
                          onMultiDownload={props.onMultiDownload}
                          onMultiMove={props.onMultiMove}
                          onMultiCopy={props.onMultiCopy}
                          onMultiCut={props.onMultiCut}
                          onFileDrop={props.onFileDrop}
                          onUploadDrop={props.onUploadDrop}
                          onPdfConvert={props.onPdfConvert}
                          onTranslateMarkdown={props.onTranslateMarkdown}
                          _filter={filter()}
                          _marks={marks()}
                          _deeps={deeps()}
                          _kinds={kinds()}
                          _chain={chain}
                        />
                      </Show>
                    </Collapsible.Content>
                  </Collapsible>
                ))}
              </Match>
              <Match when={node.type === "file"}>
                {wrapContextMenu(() => (
                  <div class="flex items-center">
                    <FileTreeNode
                      node={node}
                      level={level}
                      active={props.active}
                      selected={props.selectedPaths?.has(node.path)}
                      selectedPaths={props.selectedPaths}
                      nodeClass={props.nodeClass}
                      draggable={draggable()}
                      kinds={kinds()}
                      marks={marks()}
                      as="button"
                      type="button"
                      onClick={(e: MouseEvent) => props.onFileClick?.(node, e)}
                    >
                      <div class="w-4 shrink-0" />
                      <Switch>
                        <Match when={node.ignored}>
                          <FileIcon
                            node={node}
                            class="size-4 filetree-icon filetree-icon--mono"
                            style="color: var(--icon-weak-base)"
                            mono
                          />
                        </Match>
                        <Match when={active()}>
                          <FileIcon
                            node={node}
                            class="size-4 filetree-icon filetree-icon--mono"
                            style={kindTextColor(kind()!)}
                            mono
                          />
                        </Match>
                        <Match when={!node.ignored}>
                          <span class="filetree-iconpair size-4">
                            <FileIcon
                              node={node}
                              class="size-4 filetree-icon filetree-icon--color opacity-0 group-hover/filetree:opacity-100"
                            />
                            <FileIcon
                              node={node}
                              class="size-4 filetree-icon filetree-icon--mono group-hover/filetree:opacity-0"
                              mono
                            />
                          </span>
                        </Match>
                      </Switch>
                    </FileTreeNode>
                    <Show when={node.symlinkTarget}>
                      <Icon name="link" size="small" class="size-3.5 text-text-weak ml-1 flex-shrink-0 align-middle" />
                    </Show>
                  </div>
                ))}
              </Match>
            </Switch>
          )
        }}
      </For>
    </div>
  )
}
