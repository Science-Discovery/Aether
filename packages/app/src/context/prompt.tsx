import { createSimpleContext } from "@opencode-ai/ui/context"
import { checksum } from "@opencode-ai/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { FileSelection } from "@/context/file"
import { sanitizePromptState } from "@/context/prompt-persist"
import { Persist, persisted } from "@/utils/persist"
import {
  addReference,
  clearReferences,
  cloneReferences,
  restoreReferences,
  updateReference,
  type Reference,
} from "@/utils/ask-reference"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
}

export type ContentPart = TextPart | FileAttachmentPart | AgentPart | ImageAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type ContextItem = FileContextItem

type State = {
  prompt: Prompt
  cursor?: number
  context: { items: (ContextItem & { key: string })[] }
  references: Reference[]
}

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return partB.type === "text" && partA.content === partB.content
    case "file":
      return partB.type === "file" && partA.path === partB.path && isSelectionEqual(partA.selection, partB.selection)
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "agent") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

function contextItemKey(item: ContextItem) {
  if (item.type !== "file") return item.type
  const start = item.selection?.startLine
  const end = item.selection?.endLine
  const key = `${item.type}:${item.path}:${start}:${end}`

  if (item.commentID) {
    return `${key}:c=${item.commentID}`
  }

  const comment = item.comment?.trim()
  if (!comment) return key
  const digest = checksum(comment) ?? comment
  return `${key}:c=${digest.slice(0, 8)}`
}

function isCommentItem(item: ContextItem | (ContextItem & { key: string })) {
  return item.type === "file" && !!item.comment?.trim()
}

function createPromptActions(setStore: SetStoreFunction<State>) {
  return {
    set(prompt: Prompt, cursorPosition?: number) {
      const next = clonePrompt(prompt)
      batch(() => {
        setStore("prompt", next)
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
      })
    },
  }
}

const WORKSPACE_KEY = "__workspace__"
const MAX_PROMPT_SESSIONS = 20

type PromptSession = ReturnType<typeof createPromptSession>

export type PromptScope = {
  dir: string
  id?: string
}

type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

function createPromptSession(dir: string, id: string | undefined) {
  const legacy = `${dir}/prompt${id ? "/" + id : ""}.v2`

  const [store, setStore, _, ready] = persisted(
    {
      ...Persist.scoped(dir, id, "prompt", [legacy]),
      migrate: sanitizePromptState,
      sanitize: sanitizePromptState,
    },
    createStore<State>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
      context: {
        items: [],
      },
      references: [],
    }),
  )

  const actions = createPromptActions(setStore)

  return {
    ready,
    current: createMemo(() => store.prompt),
    cursor: createMemo(() => store.cursor),
    dirty: createMemo(() => !isPromptEqual(store.prompt, DEFAULT_PROMPT) || store.references.length > 0),
    references: {
      items: () => cloneReferences(store.references),
      add(ref: Reference) {
        setStore("references", (refs) => addReference(refs, ref))
      },
      update(id: string, question: string) {
        setStore("references", (refs) => updateReference(refs, id, question))
      },
      remove(id: string) {
        setStore("references", (refs) => cloneReferences(refs.filter((ref) => ref.id !== id)))
      },
      replace(refs: readonly Reference[]) {
        setStore("references", restoreReferences(refs))
      },
      clear(snapshot: readonly Reference[]) {
        setStore("references", (refs) => clearReferences(refs, snapshot))
      },
    },
    context: {
      items: createMemo(() => store.context.items),
      add(item: ContextItem) {
        const key = contextItemKey(item)
        if (store.context.items.find((x) => x.key === key)) return
        setStore("context", "items", (items) => [...items, { key, ...item }])
      },
      remove(key: string) {
        setStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
      removeComment(path: string, commentID: string) {
        setStore("context", "items", (items) =>
          items.filter((item) => !(item.type === "file" && item.path === path && item.commentID === commentID)),
        )
      },
      updateComment(path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) {
        setStore("context", "items", (items) =>
          items.map((item) => {
            if (item.type !== "file" || item.path !== path || item.commentID !== commentID) return item
            const value = { ...item, ...next }
            return { ...value, key: contextItemKey(value) }
          }),
        )
      },
      replaceComments(items: FileContextItem[]) {
        setStore("context", "items", (current) => [
          ...current.filter((item) => !isCommentItem(item)),
          ...items.map((item) => ({ ...item, key: contextItemKey(item) })),
        ])
      },
    },
    set: actions.set,
    reset: actions.reset,
  }
}

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    const params = useParams()
    const cache = new Map<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_PROMPT_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const owner = getOwner()
    const load = (dir: string, id: string | undefined) => {
      const key = `${dir}:${id ?? WORKSPACE_KEY}`
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot(
        (dispose) => ({
          value: createPromptSession(dir, id),
          dispose,
        }),
        owner,
      )

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const session = createMemo(() => load(params.dir!, params.id))
    const pick = (scope?: PromptScope) => (scope ? load(scope.dir, scope.id) : session())

    return {
      ready: () => session().ready(),
      current: (scope?: PromptScope) => pick(scope).current(),
      cursor: (scope?: PromptScope) => pick(scope).cursor(),
      dirty: () => session().dirty(),
      references: {
        items: (scope?: PromptScope) => pick(scope).references.items(),
        add: (ref: Reference, scope?: PromptScope) => pick(scope).references.add(ref),
        update: (id: string, question: string, scope?: PromptScope) => pick(scope).references.update(id, question),
        remove: (id: string, scope?: PromptScope) => pick(scope).references.remove(id),
        replace: (refs: readonly Reference[], scope?: PromptScope) => pick(scope).references.replace(refs),
        clear: (snapshot: readonly Reference[], scope?: PromptScope) => pick(scope).references.clear(snapshot),
      },
      context: {
        items: (scope?: PromptScope) => pick(scope).context.items(),
        add: (item: ContextItem, scope?: PromptScope) => pick(scope).context.add(item),
        remove: (key: string, scope?: PromptScope) => pick(scope).context.remove(key),
        removeComment: (path: string, commentID: string, scope?: PromptScope) =>
          pick(scope).context.removeComment(path, commentID),
        updateComment: (
          path: string,
          commentID: string,
          next: Partial<FileContextItem> & { comment?: string },
          scope?: PromptScope,
        ) => pick(scope).context.updateComment(path, commentID, next),
        replaceComments: (items: FileContextItem[], scope?: PromptScope) => pick(scope).context.replaceComments(items),
      },
      set: (prompt: Prompt, cursorPosition?: number, scope?: PromptScope) => pick(scope).set(prompt, cursorPosition),
      reset: (scope?: PromptScope) => pick(scope).reset(),
    }
  },
})
