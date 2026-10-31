import {
  batch,
  createContext,
  useContext,
  createSignal,
  Component,
  JSX,
  createEffect,
  on,
  onCleanup,
  untrack,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"
import { useLanguage } from "./language"
import { useServer } from "./server"
import { createKnowledgeClient } from "./knowledge-client"

// 知识库配置
export interface KnowledgeConfig {
  id: string
  path: string
  name: string
  providerID?: string
  embeddingProvider: "openai" | "local" | "custom"
  embeddingModel: string
  embeddingDimensions?: number
  apiKey?: string
  baseURL?: string
  chunkSize: number
  chunkOverlap: number
  // 统计信息
  documentCount?: number
  pdfFileCount?: number
  syncedAt?: number
}

// 上次使用的配置
export interface LastConfig {
  provider: string // provider ID, e.g. "openai", "siliconflow", "local"
  model: string
  apiKey: string
  baseURL: string
  dimensions: number
}

// 知识库状态
export interface KnowledgeState {
  knowledgeBases: KnowledgeConfig[]
  activeIdsBySession: Record<string, string[]>
  lastConfig?: LastConfig
}

// 知识库搜索结果
export interface KnowledgeSearchResult {
  chunk: {
    id: string
    documentId: string
    index: number
    content: string
    pageNumber?: number
  }
  document: {
    id: string
    filePath: string
    fileName: string
    fileSize: number
    pageCount: number
    status: string
  }
  score: number
}

export interface KnowledgeDocument {
  id: string
  filePath: string
  fileName: string
  fileSize: number
  pageCount?: number
  status: string
}

interface KnowledgeIndexData {
  config: {
    embeddingProvider: "openai" | "local" | "custom"
    embeddingModel: string
    embeddingDimensions: number
    apiKey?: string
    baseURL?: string
  }
  documents: Array<{ meta: KnowledgeDocument }>
  stats: {
    totalDocuments: number
    lastSyncedAt?: number
  }
}

// 嵌入模型信息
export interface EmbeddingModel {
  id: string
  name: string
  provider: "openai" | "local" | "custom"
  dimensions: number
  description: string
}

// 尚未创建的会话（项目首页输入框）使用的激活桶 key
export const NEW_SESSION_KEY = "__new__"

const DEFAULT_STATE: KnowledgeState = {
  knowledgeBases: [],
  activeIdsBySession: {},
}

interface KnowledgeContextValue {
  state: KnowledgeState
  available: () => boolean
  ready: () => boolean
  error: () => string | undefined
  retry: () => Promise<void>
  models: () => EmbeddingModel[]
  activeIds: (key?: string) => string[]
  activeKnowledgeBases: (key?: string) => KnowledgeConfig[]
  knowledgeBases: () => KnowledgeConfig[]
  enabled: (key?: string) => boolean
  syncProgress: () => { current: number; total: number } | null
  isActive: (id: string, key?: string) => boolean
  toggleActive: (id: string, key?: string) => void
  setActive: (ids: string[], key?: string) => void
  rekey: (from: string, to: string) => void
  addKnowledgeBase: (config: Omit<KnowledgeConfig, "id">) => string
  updateKnowledgeBase: (id: string, config: Partial<KnowledgeConfig>) => void
  removeKnowledgeBase: (id: string) => Promise<void>
  loadKnowledgeBase: (path: string) => Promise<KnowledgeIndexData | null>
  createKnowledgeBase: (config: KnowledgeConfig) => Promise<KnowledgeIndexData>
  syncKnowledgeBase: (id?: string) => Promise<{ added: number; updated: number; removed: number; errors?: string[] }>
  syncAllActive: () => Promise<void>
  stopSync: () => void
  listDocuments: (id: string) => Promise<KnowledgeDocument[]>
  removeDocument: (id: string, documentId: string) => Promise<void>
  importDocument: (id: string, filePath: string) => Promise<{ added: number; skipped: number; errors: string[] }>
  updateEmbeddingConfig: (
    id: string,
    cfg: {
      embeddingProvider: "openai" | "local" | "custom"
      embeddingModel: string
      apiKey?: string
      baseURL?: string
    },
  ) => Promise<void>
  search: (query: string, topK?: number, key?: string) => Promise<KnowledgeSearchResult[]>
  buildRAGContext: (results: KnowledgeSearchResult[], maxLength?: number) => string
  refreshAllStats: () => Promise<void>
  getLastConfig: () => LastConfig | undefined
  saveLastConfig: (config: LastConfig) => void
}

const KnowledgeContext = createContext<KnowledgeContextValue>()

export function useKnowledge() {
  const ctx = useContext(KnowledgeContext)
  if (!ctx) {
    throw new Error("useKnowledge must be used within a KnowledgeProvider")
  }
  return ctx
}

function generateId(): string {
  return `kb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export const KnowledgeProvider: Component<{ children: JSX.Element }> = (props) => {
  const sdk = useGlobalSDK()
  const global = useGlobalSync()
  const language = useLanguage()
  const server = useServer()

  const [state, setState] = createStore<KnowledgeState>({ ...DEFAULT_STATE })
  const [meta, setMeta] = createStore({ ready: false, loading: false, error: undefined as string | undefined })
  const available = () =>
    global.ready && (server.current?.http.url ?? sdk.url) === sdk.url && global.data.config.knowledge?.enabled === true
  const ready = () => meta.ready
  const error = () => meta.error
  const client = createKnowledgeClient({
    url: () => sdk.url,
    auth: () => sdk.auth(),
    enabled: () => available() && ready(),
    disabled: () => language.t("knowledge.disabled"),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let serial = 0
  let saved = ""
  const transfers: Array<[string, string]> = []

  const saveState = () => {
    clearTimeout(timer)
    const version = serial
    const data = JSON.stringify(state)
    if (!meta.ready || data === saved) return
    timer = setTimeout(() => {
      if (version !== serial || !meta.ready) return
      void client
        .request("/knowledge/state", { method: "POST", body: `{"data":${data}}` }, false)
        .then(() => {
          if (version === serial) saved = data
        })
        .catch(() => undefined)
    }, 500)
  }

  const [models] = createSignal<EmbeddingModel[]>([
    {
      id: "text-embedding-3-small",
      name: "OpenAI text-embedding-3-small",
      provider: "openai",
      dimensions: 1536,
      description: "OpenAI 的轻量级嵌入模型，性价比高",
    },
    {
      id: "text-embedding-3-large",
      name: "OpenAI text-embedding-3-large",
      provider: "openai",
      dimensions: 3072,
      description: "OpenAI 的高性能嵌入模型",
    },
    {
      id: "all-MiniLM-L6-v2",
      name: "all-MiniLM-L6-v2 (本地)",
      provider: "local",
      dimensions: 384,
      description: "轻量级本地嵌入模型，无需 API",
    },
  ])

  const [syncProgress, setSyncProgress] = createSignal<{ current: number; total: number } | null>(null)
  let syncAbortController: AbortController | null = null

  const stopSync = () => {
    syncAbortController?.abort()
    syncAbortController = null
    setSyncProgress(null)
  }

  const idsFor = (key?: string) => state.activeIdsBySession[key ?? NEW_SESSION_KEY] ?? []

  const activeIds = (key?: string) => idsFor(key)

  const activeKnowledgeBases = (key?: string) => {
    if (!available()) return []
    const ids = idsFor(key)
    return state.knowledgeBases.filter((kb) => ids.includes(kb.id))
  }

  const knowledgeBases = () => state.knowledgeBases

  const enabled = (key?: string) => available() && idsFor(key).length > 0

  const isActive = (id: string, key?: string) => idsFor(key).includes(id)

  const toggleActive = (id: string, key?: string) => {
    if (!ready() || !available()) return
    const bucket = key ?? NEW_SESSION_KEY
    const current = state.activeIdsBySession[bucket] ?? []
    setState(
      "activeIdsBySession",
      bucket,
      current.includes(id) ? current.filter((aid) => aid !== id) : [...current, id],
    )
  }

  const setActive = (ids: string[], key?: string) => {
    if (!ready() || !available()) return
    setState("activeIdsBySession", key ?? NEW_SESSION_KEY, ids)
  }

  const rekey = (from: string, to: string) => {
    if (from === to) return
    if (!ready()) {
      transfers.push([from, to])
      return
    }
    const ids = state.activeIdsBySession[from]
    if (!ids?.length) return
    setState("activeIdsBySession", to, ids)
    setState("activeIdsBySession", from, [])
  }

  const addKnowledgeBase = (config: Omit<KnowledgeConfig, "id">): string => {
    if (!ready() || !available()) throw new Error(language.t("knowledge.disabled"))
    const id = generateId()
    const newKb: KnowledgeConfig = { ...config, id }
    setState("knowledgeBases", [...state.knowledgeBases, newKb])
    return id
  }

  const updateKnowledgeBase = (id: string, config: Partial<KnowledgeConfig>) => {
    if (!ready() || !available()) return
    const index = state.knowledgeBases.findIndex((kb) => kb.id === id)
    if (index === -1) return
    setState("knowledgeBases", index, { ...state.knowledgeBases[index], ...config })
  }

  const refreshAllStats = async () => {
    if (!available() || !meta.ready) return
    const version = serial
    for (const kb of state.knowledgeBases) {
      try {
        const encodedPath = encodeURIComponent(kb.path)
        const stats = await client.request<{ totalDocuments: number; pdfFileCount: number; lastSyncedAt?: number }>(
          `/knowledge/${encodedPath}/stats`,
        )
        if (version !== serial || !available()) return
        updateKnowledgeBase(kb.id, {
          documentCount: stats.totalDocuments,
          pdfFileCount: stats.pdfFileCount,
          syncedAt: stats.lastSyncedAt,
        })
      } catch (e) {
        if (!available() || (e instanceof Error && e.name === "AbortError")) return
        console.error(`Failed to refresh stats for ${kb.name}:`, e)
      }
    }
  }

  const retry = async () => {
    if (meta.ready || meta.loading || (server.current?.http.url ?? sdk.url) !== sdk.url) return
    const version = serial
    setMeta({ loading: true, error: undefined })
    try {
      const data = await client.request<KnowledgeState>("/knowledge/state", {}, false)
      if (version !== serial) return
      const next = {
        knowledgeBases: data.knowledgeBases ?? [],
        activeIdsBySession: data.activeIdsBySession ?? {},
        lastConfig: data.lastConfig,
      }
      saved = JSON.stringify(next)
      for (const [from, to] of transfers.splice(0)) {
        const ids = next.activeIdsBySession[from]
        if (!ids?.length) continue
        next.activeIdsBySession = { ...next.activeIdsBySession, [to]: ids, [from]: [] }
      }
      batch(() => {
        setState(reconcile(next))
        setMeta("ready", true)
      })
    } catch (err) {
      if (version !== serial) return
      setMeta("error", err instanceof Error ? err.message : String(err))
    } finally {
      if (version === serial) setMeta("loading", false)
    }
  }

  createEffect(
    on(
      () => `${sdk.url}|${server.current?.http.url ?? sdk.url}`,
      (_key, previous) => {
        if (previous !== undefined) transfers.length = 0
        serial += 1
        clearTimeout(timer)
        client.reset()
        stopSync()
        batch(() => {
          setMeta({ ready: false, loading: false, error: undefined })
          setState(reconcile({ knowledgeBases: [], activeIdsBySession: {} }))
        })
        saved = ""
        void retry()
      },
    ),
  )

  createEffect(
    on([available, ready], async ([active, loaded]) => {
      if (!active) {
        client.reset(true)
        stopSync()
        return
      }
      if (!loaded) return
      const version = serial
      if (untrack(() => state.knowledgeBases.length) === 0) {
        const data = await client
          .request<{ found?: Array<{ path: string; config?: Partial<KnowledgeConfig> }> }>("/knowledge/discover")
          .catch(() => undefined)
        if (!data?.found?.length || !available() || version !== serial) return
        setState(
          "knowledgeBases",
          data.found.map((item) => ({
            id: generateId(),
            path: item.path,
            name: item.config?.name ?? item.path.split(/[\\/]/).pop() ?? "Recovered KB",
            providerID: "",
            embeddingProvider: item.config?.embeddingProvider ?? "custom",
            embeddingModel: item.config?.embeddingModel ?? "",
            embeddingDimensions: item.config?.embeddingDimensions,
            apiKey: item.config?.apiKey ?? "",
            baseURL: item.config?.baseURL ?? "",
            chunkSize: item.config?.chunkSize ?? 500,
            chunkOverlap: item.config?.chunkOverlap ?? 50,
          })),
        )
      }
      await refreshAllStats()
    }),
  )

  // 状态变更时自动持久化
  createEffect(
    on(
      () => JSON.stringify(state),
      () => {
        saveState()
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    serial += 1
    transfers.length = 0
    clearTimeout(timer)
    client.reset()
    stopSync()
  })

  const loadKnowledgeBase = async (path: string): Promise<KnowledgeIndexData | null> => {
    const encodedPath = encodeURIComponent(path)
    return client.request<KnowledgeIndexData>(`/knowledge/${encodedPath}`, {}, false).catch(() => null)
  }

  const createKnowledgeBase = async (cfg: KnowledgeConfig): Promise<KnowledgeIndexData> => {
    return client.request<KnowledgeIndexData>("/knowledge", {
      method: "POST",
      body: JSON.stringify({
        path: cfg.path,
        name: cfg.name,
        embeddingProvider: cfg.embeddingProvider,
        embeddingModel: cfg.embeddingModel,
        embeddingDimensions: cfg.embeddingDimensions,
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        chunkSize: cfg.chunkSize,
        chunkOverlap: cfg.chunkOverlap,
      }),
    })
  }

  const syncKnowledgeBase = async (id?: string) => {
    if (!available()) throw new Error(language.t("knowledge.disabled"))
    const targetId = id ?? activeIds()[0] ?? null
    if (!targetId) {
      throw new Error("No knowledge base selected")
    }

    const kb = state.knowledgeBases.find((k) => k.id === targetId)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }

    setSyncProgress(null)
    const encodedPath = encodeURIComponent(kb.path)
    stopSync()
    const abort = new AbortController()
    syncAbortController = abort
    const signal = abort.signal
    const timeout = setTimeout(() => abort.abort(), 600000)

    try {
      await client.request("/knowledge/config", {
        method: "POST",
        body: JSON.stringify({
          path: kb.path,
          apiKey: kb.apiKey,
          baseURL: kb.baseURL,
        }),
        signal,
      })

      const pending = await client.open(`/knowledge/${encodedPath}/sync`, {
        method: "POST",
        body: JSON.stringify({
          apiKey: kb.apiKey,
          baseURL: kb.baseURL,
        }),
        signal,
      })

      let finalResult: { added: number; updated: number; removed: number; errors?: string[] } = {
        added: 0,
        updated: 0,
        removed: 0,
      }

      const reader = pending.response.body?.getReader()
      if (!reader) {
        pending.close()
        throw new Error("Knowledge sync response has no content")
      }
      const cancel = () => void reader.cancel().catch(() => undefined)
      pending.signal.addEventListener("abort", cancel, { once: true })
      if (pending.signal.aborted) cancel()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const { done, value } = await reader.read()
          pending.check()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const parts = buffer.split("\n\n")
          buffer = parts.pop() ?? ""

          for (const block of parts) {
            let event = "message"
            let data = ""
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7).trim()
              else if (line.startsWith("data: ")) data = line.slice(6).trim()
            }
            if (!data) continue

            if (event === "progress") {
              const status = JSON.parse(data)
              setSyncProgress({ current: status.current, total: status.total })
            } else if (event === "complete") {
              finalResult = JSON.parse(data)
              const stats = await client.request<{ totalDocuments: number; pdfFileCount: number }>(
                `/knowledge/${encodedPath}/stats`,
                { signal },
              )
              pending.check()
              updateKnowledgeBase(targetId, {
                documentCount: stats.totalDocuments,
                pdfFileCount: stats.pdfFileCount,
                syncedAt: Date.now(),
              })
            } else if (event === "error") {
              const errData = JSON.parse(data)
              throw new Error(errData.message)
            }
          }
        }
      } finally {
        pending.signal.removeEventListener("abort", cancel)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
        pending.close()
      }

      return finalResult
    } finally {
      clearTimeout(timeout)
      abort.abort()
      if (syncAbortController === abort) {
        setSyncProgress(null)
        syncAbortController = null
      }
    }
  }

  const syncAllActive = async () => {
    for (const id of new Set(Object.values(state.activeIdsBySession).flat())) {
      await syncKnowledgeBase(id)
    }
  }

  const listDocuments = async (id: string): Promise<KnowledgeDocument[]> => {
    const kb = state.knowledgeBases.find((item) => item.id === id)
    if (!kb) return []
    const index = await loadKnowledgeBase(kb.path)
    if (!index?.documents) return []
    return index.documents.map((item) => item.meta)
  }

  const removeDocument = async (id: string, documentId: string) => {
    if (!ready()) throw new Error(language.t("knowledge.disabled"))
    const version = serial
    const kb = state.knowledgeBases.find((item) => item.id === id)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }
    const encodedPath = encodeURIComponent(kb.path)
    const index = await client.request<KnowledgeIndexData>(
      `/knowledge/${encodedPath}/document/${encodeURIComponent(documentId)}`,
      { method: "DELETE" },
      false,
    )
    if (version !== serial) return
    setState("knowledgeBases", (kb) => kb.id === id, {
      documentCount: index.stats.totalDocuments,
      syncedAt: index.stats.lastSyncedAt,
    })
  }

  const importDocument = async (id: string, filePath: string) => {
    const kb = state.knowledgeBases.find((item) => item.id === id)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }
    const encodedPath = encodeURIComponent(kb.path)
    return client.request<{ added: number; skipped: number; errors: string[] }>(`/knowledge/${encodedPath}/import`, {
      method: "POST",
      body: JSON.stringify({ paths: [filePath] }),
    })
  }

  const updateEmbeddingConfig = async (
    id: string,
    cfg: {
      embeddingProvider: "openai" | "local" | "custom"
      embeddingModel: string
      apiKey?: string
      baseURL?: string
    },
  ) => {
    const version = serial
    const kb = state.knowledgeBases.find((item) => item.id === id)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }

    const encodedPath = encodeURIComponent(kb.path)
    const index = await client.request<KnowledgeIndexData>(`/knowledge/${encodedPath}/config`, {
      method: "PATCH",
      body: JSON.stringify(cfg),
    })
    if (version !== serial || !available()) return

    updateKnowledgeBase(id, {
      embeddingProvider: index.config.embeddingProvider,
      embeddingModel: index.config.embeddingModel,
      embeddingDimensions: index.config.embeddingDimensions,
      apiKey: index.config.apiKey,
      baseURL: index.config.baseURL,
      documentCount: index.stats.totalDocuments,
      syncedAt: index.stats.lastSyncedAt,
    })
  }

  const search = async (query: string, topK: number = 5, key?: string): Promise<KnowledgeSearchResult[]> => {
    const kbs = activeKnowledgeBases(key)
    if (kbs.length === 0) {
      return []
    }

    const allResults: KnowledgeSearchResult[] = []

    for (const kb of kbs) {
      const encodedPath = encodeURIComponent(kb.path)
      const results = await client.request<KnowledgeSearchResult[]>(`/knowledge/${encodedPath}/search`, {
        method: "POST",
        body: JSON.stringify({
          query,
          topK,
          apiKey: kb.apiKey,
          baseURL: kb.baseURL,
        }),
      })

      allResults.push(...results)
    }

    allResults.sort((a, b) => b.score - a.score)
    return allResults.slice(0, topK)
  }

  const removeKnowledgeBase = async (id?: string) => {
    if (!ready()) throw new Error(language.t("knowledge.disabled"))
    const version = serial
    const targetId = id ?? activeIds()[0] ?? null
    if (!targetId) return

    const kb = state.knowledgeBases.find((k) => k.id === targetId)
    if (!kb) return

    const encodedPath = encodeURIComponent(kb.path)
    await client.request(`/knowledge/${encodedPath}`, { method: "DELETE" }, false)
    if (version !== serial) return

    setState(
      "knowledgeBases",
      state.knowledgeBases.filter((k) => k.id !== targetId),
    )
    setState(
      "activeIdsBySession",
      Object.fromEntries(
        Object.entries(state.activeIdsBySession).map(([key, ids]) => [key, ids.filter((aid) => aid !== targetId)]),
      ),
    )
  }

  const buildRAGContext = (results: KnowledgeSearchResult[], maxLength: number = 4000): string => {
    if (results.length === 0) return ""

    const parts: string[] = []
    let totalLength = 0

    for (const result of results) {
      const header = `[文档: ${result.document.fileName}]`
      const content = result.chunk.content
      const part = `${header}\n${content}\n`

      if (totalLength + part.length > maxLength) break

      parts.push(part)
      totalLength += part.length
    }

    return parts.join("\n---\n\n")
  }

  const getLastConfig = () => state.lastConfig

  const saveLastConfig = (config: LastConfig) => {
    if (!ready() || !available()) return
    setState("lastConfig", config)
  }

  const value: KnowledgeContextValue = {
    state,
    available,
    ready,
    error,
    retry,
    models,
    activeIds,
    activeKnowledgeBases,
    knowledgeBases,
    enabled,
    syncProgress,
    isActive,
    toggleActive,
    setActive,
    rekey,
    addKnowledgeBase,
    updateKnowledgeBase,
    removeKnowledgeBase,
    loadKnowledgeBase,
    createKnowledgeBase,
    syncKnowledgeBase,
    syncAllActive,
    stopSync,
    listDocuments,
    removeDocument,
    importDocument,
    updateEmbeddingConfig,
    search,
    buildRAGContext,
    refreshAllStats,
    getLastConfig,
    saveLastConfig,
  }

  return <KnowledgeContext.Provider value={value}>{props.children}</KnowledgeContext.Provider>
}
