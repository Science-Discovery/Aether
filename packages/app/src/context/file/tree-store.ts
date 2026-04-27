import { createStore, produce, reconcile } from "solid-js/store"
import type { FileNode } from "@opencode-ai/sdk/v2"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
  /** 初始展开的目录路径集合（从持久化存储恢复，只在创建时读一次） */
  initialExpanded?: Set<string>
  /** 目录展开/折叠变化时的回调（用于持久化） */
  onExpandedChange?: (expanded: Set<string>) => void
}

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const inflight = new Map<string, Promise<void>>()

  const applyExpanded = (dirs?: Iterable<string>) => {
    if (!dirs) return
    for (const dir of dirs) {
      if (dir === "") continue
      setTree("dir", dir, (prev) => ({ ...(prev ?? {}), expanded: true }))
    }
  }
  applyExpanded(options.initialExpanded)

  /** 收集当前所有展开的目录（不含根目录） */
  const getExpandedSet = (): Set<string> => {
    const result = new Set<string>()
    for (const [path, state] of Object.entries(tree.dir)) {
      if (path !== "" && state.expanded) result.add(path)
    }
    return result
  }

  const reset = (dirs?: Iterable<string>) => {
    inflight.clear()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
    applyExpanded(dirs ?? options.initialExpanded)
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    // 检查是否在初始展开集合中
    const initial = options.initialExpanded
    setTree("dir", path, { expanded: initial?.has(path) ?? false })
  }

  const listDir = (input: string, opts?: { force?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Promise.resolve()

    const pending = inflight.get(dir)
    if (pending) return pending

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )

    const directory = options.scope()

    const promise = options
      .list(dir)
      .then((nodes) => {
        if (options.scope() !== directory) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = new Set(nextChildren)

        setTree(
          "node",
          produce((draft) => {
            const removedDirs: string[] = []

            for (const child of prevChildren) {
              if (nextSet.has(child)) continue
              const existing = draft[child]
              if (existing?.type === "directory") removedDirs.push(child)
              delete draft[child]
            }

            if (removedDirs.length > 0) {
              const keys = Object.keys(draft)
              for (const key of keys) {
                for (const removed of removedDirs) {
                  if (!key.startsWith(removed + "/")) continue
                  delete draft[key]
                  break
                }
              }
            }

            for (const node of nodes) {
              draft[node.path] = node
            }
          }),
        )

        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loaded = true
            draft.loading = false
            draft.children = nextChildren
          }),
        )
      })
      .catch((e) => {
        if (options.scope() !== directory) return
        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loading = false
            draft.error = e.message
          }),
        )
        options.onError(e.message)
      })
      .finally(() => {
        inflight.delete(dir)
      })

    inflight.set(dir, promise)
    return promise
  }

  const refreshDir = (input: string) => {
    const root = options.normalizeDir(input)
    const dirs = new Set([root])

    for (const [dir, state] of Object.entries(tree.dir)) {
      if (!state.loaded) continue
      if (dir !== root && !dir.startsWith(root === "" ? "" : `${root}/`)) continue
      dirs.add(dir)
    }

    return Promise.all(
      [...dirs].sort((a, b) => a.split("/").length - b.split("/").length).map((dir) => listDir(dir, { force: true })),
    ).then(() => {})
  }

  const revealPath = async (input: string) => {
    const path = options.normalizeDir(input)
    const parts = path.split("/").slice(0, -1)

    await listDir("")

    let dir = ""
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part
      expandDir(dir)
      await listDir(dir)
    }
  }

  const expandDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    void listDir(dir)
    options.onExpandedChange?.(getExpandedSet())
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
    options.onExpandedChange?.(getExpandedSet())
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  return {
    listDir,
    refreshDir,
    revealPath,
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    reset,
  }
}
