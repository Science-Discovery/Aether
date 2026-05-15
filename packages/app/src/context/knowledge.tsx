import { createContext, useContext, createSignal, Component, JSX, onMount, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "./global-sdk"
import { useServer } from "./server"

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
  activeIds: string[]
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

const DEFAULT_STATE: KnowledgeState = {
  knowledgeBases: [],
  activeIds: [],
}

interface KnowledgeContextValue {
  state: KnowledgeState
  models: () => EmbeddingModel[]
  activeKnowledgeBases: () => KnowledgeConfig[]
  knowledgeBases: () => KnowledgeConfig[]
  enabled: () => boolean
  syncProgress: () => { current: number; total: number } | null
  isActive: (id: string) => boolean
  toggleActive: (id: string) => void
  setActive: (ids: string[]) => void
  addKnowledgeBase: (config: Omit<KnowledgeConfig, "id">) => string
  updateKnowledgeBase: (id: string, config: Partial<KnowledgeConfig>) => void
  removeKnowledgeBase: (id: string) => Promise<void>
  loadKnowledgeBase: (path: string) => Promise<KnowledgeIndexData | null>
  createKnowledgeBase: (config: KnowledgeConfig) => Promise<any>
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
  search: (query: string, topK?: number) => Promise<KnowledgeSearchResult[]>
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
  const server = useServer()

  const [state, setState] = createStore<KnowledgeState>({ ...DEFAULT_STATE })

  let initDone = false
  let saveTimer: ReturnType<typeof setTimeout>

  const loadState = async () => {
    try {
      const resp = await fetchApi("/knowledge/state")
      if (resp.ok) {
        const remote = await resp.json()
        if (remote.knowledgeBases?.length > 0) setState(remote)
        return remote.knowledgeBases?.length > 0
      }
    } catch {}
    return false
  }

  const saveState = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      fetchApi("/knowledge/state", {
        method: "POST",
        body: JSON.stringify({
          data: {
            knowledgeBases: state.knowledgeBases,
            activeIds: state.activeIds,
            lastConfig: state.lastConfig,
          },
        }),
      }).catch(() => {})
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
  }

  const activeKnowledgeBases = () => {
    const ids = state.activeIds
    return state.knowledgeBases.filter((kb) => ids.includes(kb.id))
  }

  const knowledgeBases = () => state.knowledgeBases

  const enabled = () => state.activeIds.length > 0

  const isActive = (id: string) => state.activeIds.includes(id)

  const toggleActive = (id: string) => {
    const current = state.activeIds
    if (current.includes(id)) {
      setState(
        "activeIds",
        current.filter((aid) => aid !== id),
      )
    } else {
      setState("activeIds", [...current, id])
    }
  }

  const setActive = (ids: string[]) => {
    setState("activeIds", ids)
  }

  const addKnowledgeBase = (config: Omit<KnowledgeConfig, "id">): string => {
    const id = generateId()
    const newKb: KnowledgeConfig = { ...config, id }
    setState("knowledgeBases", [...state.knowledgeBases, newKb])
    return id
  }

  const updateKnowledgeBase = (id: string, config: Partial<KnowledgeConfig>) => {
    const index = state.knowledgeBases.findIndex((kb) => kb.id === id)
    if (index === -1) return
    setState("knowledgeBases", index, { ...state.knowledgeBases[index], ...config })
  }

  const fetchApi = async (path: string, options: RequestInit = {}) => {
    const baseUrl = sdk.url
    const s = server.current?.http
    const authHeader: Record<string, string> = s?.password
      ? { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
      : {}
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...authHeader,
      ...(options.headers as Record<string, string>),
    }

    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
    })

    return response
  }

  const refreshAllStats = async () => {
    for (const kb of state.knowledgeBases) {
      try {
        const encodedPath = encodeURIComponent(kb.path)
        const response = await fetchApi(`/knowledge/${encodedPath}/stats`)
        if (response.ok) {
          const stats = await response.json()
          updateKnowledgeBase(kb.id, {
            documentCount: stats.totalDocuments,
            pdfFileCount: stats.pdfFileCount,
            syncedAt: stats.lastSyncedAt,
          })
        }
      } catch (e) {
        console.error(`Failed to refresh stats for ${kb.name}:`, e)
      }
    }
  }

  onMount(async () => {
    const hasRemote = await loadState()
    initDone = true

    if (!hasRemote) {
      // 尝试从 .aether-kb 目录扫描恢复
      try {
        const resp = await fetchApi("/knowledge/discover")
        if (resp.ok) {
          const { found } = await resp.json()
          if (found?.length > 0) {
            for (const item of found) {
              const id = generateId()
              setState("knowledgeBases", (list) => [
                ...list,
                {
                  id,
                  path: item.path,
                  name: item.config?.name ?? item.path.split("/").pop() ?? "Recovered KB",
                  providerID: "",
                  embeddingProvider: item.config?.embeddingProvider ?? "custom",
                  embeddingModel: item.config?.embeddingModel ?? "",
                  embeddingDimensions: item.config?.embeddingDimensions,
                  apiKey: item.config?.apiKey ?? "",
                  baseURL: item.config?.baseURL ?? "",
                  chunkSize: item.config?.chunkSize ?? 500,
                  chunkOverlap: item.config?.chunkOverlap ?? 50,
                } as KnowledgeConfig,
              ])
            }
            saveState()
          }
        }
      } catch {}
    }

    if (state.knowledgeBases.length > 0) {
      refreshAllStats()
    }

    // 恢复后端 knowledge_search 工具的进程内存配置（重启后丢失）
    for (const kb of state.knowledgeBases) {
      if (!state.activeIds.includes(kb.id)) continue
      fetchApi("/knowledge/config", {
        method: "POST",
        body: JSON.stringify({
          path: kb.path,
          apiKey: kb.apiKey,
          baseURL: kb.baseURL,
        }),
      }).catch(() => {})
    }
  })

  // 状态变更时自动持久化
  createEffect(
    on(
      () => ({
        knowledgeBases: state.knowledgeBases,
        activeIds: state.activeIds,
        lastConfig: state.lastConfig,
      }),
      () => {
        if (!initDone) return
        saveState()
      },
      { defer: true },
    ),
  )

  const loadKnowledgeBase = async (path: string): Promise<KnowledgeIndexData | null> => {
    const encodedPath = encodeURIComponent(path)
    const response = await fetchApi(`/knowledge/${encodedPath}`, {
      method: "GET",
    })

    if (!response.ok) {
      return null
    }

    return response.json()
  }

  const createKnowledgeBase = async (cfg: KnowledgeConfig): Promise<KnowledgeIndexData> => {
    const response = await fetchApi("/knowledge", {
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

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to create knowledge base: ${error}`)
    }

    return response.json()
  }

  const syncKnowledgeBase = async (id?: string) => {
    const targetId = id ?? (state.activeIds.length > 0 ? state.activeIds[0] : null)
    if (!targetId) {
      throw new Error("No knowledge base selected")
    }

    const kb = state.knowledgeBases.find((k) => k.id === targetId)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }

    setSyncProgress(null)
    const encodedPath = encodeURIComponent(kb.path)
    const baseUrl = sdk.url

    await fetchApi("/knowledge/config", {
      method: "POST",
      body: JSON.stringify({
        path: kb.path,
        apiKey: kb.apiKey,
        baseURL: kb.baseURL,
      }),
    })

    syncAbortController = new AbortController()
    const timeoutSignal = AbortSignal.timeout(600000)
    const combinedSignal = AbortSignal.any
      ? AbortSignal.any([syncAbortController.signal, timeoutSignal])
      : syncAbortController.signal

    const response = await fetch(`${baseUrl}/knowledge/${encodedPath}/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(server.current?.http?.password
          ? {
              Authorization: `Basic ${btoa(`${server.current.http.username ?? "opencode"}:${server.current.http.password}`)}`,
            }
          : {}),
      } as Record<string, string>,
      body: JSON.stringify({
        apiKey: kb.apiKey,
        baseURL: kb.baseURL,
      }),
      signal: combinedSignal,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to sync knowledge base: ${error}`)
    }

    let finalResult: { added: number; updated: number; removed: number; errors?: string[] } = {
      added: 0,
      updated: 0,
      removed: 0,
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
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
            const statsResponse = await fetchApi(`/knowledge/${encodedPath}/stats`)
            if (statsResponse.ok) {
              const stats = await statsResponse.json()
              updateKnowledgeBase(targetId, {
                documentCount: stats.totalDocuments,
                pdfFileCount: stats.pdfFileCount,
                syncedAt: Date.now(),
              })
            }
          } else if (event === "error") {
            const errData = JSON.parse(data)
            throw new Error(errData.message)
          }
        }
      }
    } finally {
      setSyncProgress(null)
      syncAbortController = null
      reader.releaseLock()
    }

    return finalResult
  }

  const syncAllActive = async () => {
    for (const id of state.activeIds) {
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
    const kb = state.knowledgeBases.find((item) => item.id === id)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }
    const encodedPath = encodeURIComponent(kb.path)
    const response = await fetchApi(`/knowledge/${encodedPath}/document/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to remove document: ${error}`)
    }

    const index = await response.json()
    updateKnowledgeBase(id, {
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
    const response = await fetchApi(`/knowledge/${encodedPath}/import`, {
      method: "POST",
      body: JSON.stringify({ paths: [filePath] }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to import document: ${error}`)
    }

    return response.json() as Promise<{ added: number; skipped: number; errors: string[] }>
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
    const kb = state.knowledgeBases.find((item) => item.id === id)
    if (!kb) {
      throw new Error("Knowledge base not found")
    }

    const encodedPath = encodeURIComponent(kb.path)
    const response = await fetchApi(`/knowledge/${encodedPath}/config`, {
      method: "PATCH",
      body: JSON.stringify(cfg),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to update embedding config: ${error}`)
    }

    const index = await response.json()
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

  const search = async (query: string, topK: number = 5): Promise<KnowledgeSearchResult[]> => {
    const kbs = activeKnowledgeBases()
    if (kbs.length === 0) {
      return []
    }

    const allResults: KnowledgeSearchResult[] = []

    for (const kb of kbs) {
      const encodedPath = encodeURIComponent(kb.path)
      const response = await fetchApi(`/knowledge/${encodedPath}/search`, {
        method: "POST",
        body: JSON.stringify({
          query,
          topK,
          apiKey: kb.apiKey,
          baseURL: kb.baseURL,
        }),
      })

      if (response.ok) {
        const results = await response.json()
        allResults.push(...results)
      }
    }

    allResults.sort((a, b) => b.score - a.score)
    return allResults.slice(0, topK)
  }

  const removeKnowledgeBase = async (id?: string) => {
    const targetId = id ?? (state.activeIds.length > 0 ? state.activeIds[0] : null)
    if (!targetId) return

    const kb = state.knowledgeBases.find((k) => k.id === targetId)
    if (!kb) return

    const encodedPath = encodeURIComponent(kb.path)
    const response = await fetchApi(`/knowledge/${encodedPath}`, {
      method: "DELETE",
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to remove knowledge base: ${error}`)
    }

    const newIndex = state.knowledgeBases.filter((k) => k.id !== targetId)
    setState("knowledgeBases", newIndex)
    setState(
      "activeIds",
      state.activeIds.filter((aid) => aid !== targetId),
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
    setState("lastConfig", config)
  }

  const value: KnowledgeContextValue = {
    state,
    models,
    activeKnowledgeBases,
    knowledgeBases,
    enabled,
    syncProgress,
    isActive,
    toggleActive,
    setActive,
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
