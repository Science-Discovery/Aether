import { Component, Show, For, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useKnowledge } from "@/context/knowledge"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useProviders } from "@/hooks/use-providers"
import {
  labelResolvedEmbeddingModel,
  labelProvider,
  type ProviderConnection,
  type ResolvedEmbeddingModel,
  toEmbeddingProvider,
} from "@/utils/knowledge-embedding"
import { DialogSelectDirectory } from "./dialog-select-directory"

export const SettingsKnowledge: Component = () => {
  const knowledge = useKnowledge()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const server = useServer()
  const providers = useProviders()

  const [syncing, setSyncing] = createSignal<string | null>(null)
  const [error, setError] = createSignal("")
  const [success, setSuccess] = createSignal("")
  const [showAddForm, setShowAddForm] = createSignal(false)

  const [newPath, setNewPath] = createSignal("")
  const [newName, setNewName] = createSignal("My Knowledge Base")
  const [selectedProviderID, setSelectedProviderID] = createSignal("")
  const [newModel, setNewModel] = createSignal("")
  const [newApiKey, setNewApiKey] = createSignal("")
  const [newBaseURL, setNewBaseURL] = createSignal("")
  const [newProviderType, setNewProviderType] = createSignal<"openai" | "local" | "custom">("local")
  const [newChunkSize, setNewChunkSize] = createSignal(500)
  const [newChunkOverlap, setNewChunkOverlap] = createSignal(50)

  const [embeddingModelOptions, setEmbeddingModelOptions] = createSignal<string[]>([])
  const [resolvedModels, setResolvedModels] = createSignal<ResolvedEmbeddingModel[]>([])
  const [loadingModels, setLoadingModels] = createSignal(false)
  const [useManualModel, setUseManualModel] = createSignal(false)
  let run = 0

  // Connected providers + local
  const connected = createMemo(() => providers.connected())
  const providerOptions = createMemo(() => ["local", ...connected().map((p) => p.id)])

  onMount(() => {
    const lastConfig = knowledge.getLastConfig()
    if (lastConfig) {
      // Restore provider and trigger selection
      if (lastConfig.provider) {
        void handleProviderSelect(lastConfig.provider, lastConfig.model)
      }
    }
    void knowledge.refreshAllStats()
  })

  const fetchProviderConnection = async (id: string) => {
    const baseUrl = sdk.url
    const s = server.current?.http
    const authHeader: Record<string, string> = s?.password
      ? { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
      : {}
    const resp = await fetch(`${baseUrl}/provider/${encodeURIComponent(id)}/connection`, {
      headers: { "Content-Type": "application/json", ...authHeader },
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json() as Promise<ProviderConnection>
  }

  const setModels = (id: string, extra: ResolvedEmbeddingModel[] = [], pick?: string) => {
    const list =
      id === "local"
        ? knowledge
            .models()
            .filter((item) => item.provider === "local")
            .map((item) => item.id)
        : Array.from(new Set(extra.map((item) => item.id)))
    const next = pick && !list.includes(pick) ? [pick, ...list] : list
    setResolvedModels(extra)
    setEmbeddingModelOptions(next)

    if (pick) {
      if (next.includes(pick)) {
        setUseManualModel(false)
        setNewModel(pick)
        return
      }
      setUseManualModel(true)
      setNewModel(pick)
      return
    }

    if (next.length > 0) {
      setUseManualModel(false)
      setNewModel(next[0]!)
      return
    }

    setUseManualModel(true)
    setNewModel("")
  }

  const handleProviderSelect = async (id: string | undefined, pick?: string) => {
    if (!id) return
    const cur = ++run
    setSelectedProviderID(id)
    setNewProviderType(id === "local" ? "local" : toEmbeddingProvider(id))
    setLoadingModels(id !== "local")
    setNewApiKey("")
    setNewBaseURL("")
    setModels(id, [], pick)

    if (id === "local") {
      return
    }

    try {
      const data = await fetchProviderConnection(id)
      if (cur !== run) return
      setNewProviderType(data.embeddingProvider)
      if (data.baseURL) setNewBaseURL(data.baseURL)
      if (data.apiKey) setNewApiKey(data.apiKey)
      setModels(id, data.embeddingModels, pick)
    } catch {
      if (cur !== run) return
    } finally {
      if (cur === run) setLoadingModels(false)
    }
  }

  const handleSelectFolder = () => {
    dialog.show(() => (
      <DialogSelectDirectory
        title="Select Knowledge Base Folder"
        onSelect={(result) => {
          if (result && typeof result === "string") {
            const parts = result.split("/")
            const name = parts[parts.length - 1] || "Knowledge Base"
            setNewPath(result)
            setNewName(name)
          }
        }}
      />
    ))
  }

  const handleAddKnowledgeBase = async () => {
    setError("")
    setSuccess("")

    if (!newPath()) {
      setError("Please select a folder")
      return
    }
    if (!selectedProviderID()) {
      setError("Please select an embedding provider")
      return
    }
    if (!newModel()) {
      setError("Please select or enter an embedding model")
      return
    }
    if (newProviderType() === "custom" && !newBaseURL()) {
      setError("Could not resolve provider API URL. Please check your provider configuration.")
      return
    }

    setSyncing("new")
    try {
      const id = knowledge.addKnowledgeBase({
        path: newPath(),
        name: newName(),
        providerID: selectedProviderID(),
        embeddingProvider: newProviderType(),
        embeddingModel: newModel(),
        apiKey: newApiKey(),
        baseURL: newBaseURL(),
        chunkSize: newChunkSize(),
        chunkOverlap: newChunkOverlap(),
      })

      knowledge.toggleActive(id)

      const kb = knowledge.knowledgeBases().find((k) => k.id === id)
      if (kb) {
        let index = await knowledge.loadKnowledgeBase(kb.path)
        if (!index) {
          index = await knowledge.createKnowledgeBase(kb)
        }
      }

      const result = await knowledge.syncKnowledgeBase(id)

      if (result.errors && result.errors.length > 0) {
        setError(`Synced with ${result.errors.length} errors: ${result.errors.slice(0, 3).join(", ")}`)
      } else {
        setSuccess(`Added ${result.added} documents, updated ${result.updated}`)
      }

      knowledge.saveLastConfig({
        provider: selectedProviderID(),
        model: newModel(),
        apiKey: newApiKey(),
        baseURL: newBaseURL(),
        dimensions:
          resolvedModels().find((item) => item.id === newModel())?.dimensions ??
          knowledge.models().find((item) => item.id === newModel())?.dimensions ??
          1536,
      })

      setShowAddForm(false)
      setNewPath("")
      setNewName("My Knowledge Base")
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
    } finally {
      setSyncing(null)
    }
  }

  const handleSync = async (id: string) => {
    setError("")
    setSuccess("")
    setSyncing(id)
    try {
      const result = await knowledge.syncKnowledgeBase(id)
      if (result.errors && result.errors.length > 0) {
        setError(`Synced with ${result.errors.length} errors: ${result.errors.slice(0, 3).join(", ")}`)
      } else {
        setSuccess(`Added ${result.added} documents, updated ${result.updated}`)
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
    } finally {
      setSyncing(null)
    }
  }

  const handleRemove = async (id: string) => {
    if (confirm("Are you sure you want to remove this knowledge base?")) {
      setError("")
      setSuccess("")
      await knowledge.removeKnowledgeBase(id)
    }
  }

  const handleSelect = (id: string) => {
    knowledge.toggleActive(id)
    const kb = knowledge.knowledgeBases().find((k) => k.id === id)
    if (kb) {
      knowledge.loadKnowledgeBase(kb.path)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">Knowledge Base</h2>
          <p class="text-14-regular text-text-weak">
            Configure local folders as knowledge bases for RAG-powered context in conversations.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-6 max-w-[720px]">
        <Show when={knowledge.knowledgeBases().length > 0}>
          <div class="flex flex-col gap-3">
            <h3 class="text-14-medium text-text-strong">Knowledge Bases</h3>
            <div class="bg-surface-raised-base rounded-lg overflow-hidden">
              <For each={knowledge.knowledgeBases()}>
                {(kb) => {
                  const isActive = createMemo(() => knowledge.state.activeIds.includes(kb.id))
                  const isSyncing = createMemo(() => syncing() === kb.id)
                  return (
                    <div
                      class="flex items-center gap-3 p-4 border-b border-border-weak-base last:border-b-0 cursor-pointer hover:bg-surface-base transition-colors"
                      onClick={() => handleSelect(kb.id)}
                    >
                      <div class="flex items-center justify-center size-5 shrink-0">
                        <div
                          class="size-4 rounded border flex items-center justify-center"
                          classList={{
                            "border-border-interactive bg-surface-interactive": isActive(),
                            "border-border-base bg-transparent": !isActive(),
                          }}
                        >
                          <Show when={isActive()}>
                            <Icon name="check" class="size-3 text-icon-success-base" />
                          </Show>
                        </div>
                      </div>
                      <div class="flex-1 min-w-0">
                        <div class="text-14-medium text-text-strong truncate">{kb.name}</div>
                        <div class="text-12-regular text-text-weak truncate">{kb.path}</div>
                      </div>
                      <div class="flex items-center gap-2 text-12-regular text-text-base shrink-0">
                        <span>{kb.pdfFileCount ?? kb.documentCount ?? 0} docs</span>
                      </div>
                      <div class="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            handleSync(kb.id)
                          }}
                          disabled={isSyncing()}
                          class="h-7 px-2"
                        >
                          <Icon name="arrow-down-to-line" class="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            handleRemove(kb.id)
                          }}
                          class="h-7 px-2 text-text-error"
                        >
                          <Icon name="trash" class="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        <Show when={!showAddForm()}>
          <Button variant="secondary" onClick={() => setShowAddForm(true)} class="w-fit">
            <Icon name="plus" class="size-4 mr-1" />
            Add Knowledge Base
          </Button>
        </Show>

        <Show when={showAddForm()}>
          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <h3 class="text-14-medium text-text-strong">New Knowledge Base</h3>
              <Button variant="ghost" size="small" onClick={() => setShowAddForm(false)} class="h-7 px-2">
                <Icon name="close" class="size-4" />
              </Button>
            </div>

            <div class="bg-surface-raised-base px-4 rounded-lg">
              {/* Folder Path */}
              <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base">
                <div class="flex flex-col min-w-0 flex-1">
                  <span class="text-14-medium text-text-strong">Folder Path</span>
                  <span class="text-12-regular text-text-weak">Local folder containing PDF files</span>
                </div>
                <div class="flex gap-2 items-center min-w-0 flex-1 max-w-xs">
                  <input
                    type="text"
                    value={newPath()}
                    onInput={(e) => setNewPath(e.currentTarget.value)}
                    placeholder="/path/to/your/papers"
                    class="h-9 flex-1 min-w-0 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                  />
                  <Button variant="secondary" size="small" onClick={handleSelectFolder} class="h-9 px-3 shrink-0">
                    <Icon name="folder" class="size-4" />
                  </Button>
                </div>
              </div>

              {/* Name */}
              <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base">
                <div class="flex flex-col min-w-0 flex-1">
                  <span class="text-14-medium text-text-strong">Name</span>
                </div>
                <input
                  type="text"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  placeholder="My Knowledge Base"
                  class="h-9 flex-1 max-w-xs rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                />
              </div>

              {/* Embedding Provider — select from configured providers */}
              <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base">
                <div class="flex flex-col min-w-0 flex-1">
                  <span class="text-14-medium text-text-strong">Embedding Provider</span>
                  <span class="text-12-regular text-text-weak">Choose a configured provider to use for embeddings</span>
                </div>
                <Select
                  options={providerOptions()}
                  current={selectedProviderID()}
                  value={(id) => id}
                  label={(id) => labelProvider(id, connected())}
                  onSelect={handleProviderSelect}
                  variant="secondary"
                  size="small"
                  class="w-48"
                />
              </div>

              {/* Embedding Model */}
              <Show when={selectedProviderID()}>
                <div class="flex flex-col gap-3 py-3 border-b border-border-weak-base">
                  <div class="flex flex-col min-w-0">
                    <span class="text-14-medium text-text-strong">Embedding Model</span>
                    <Show when={newProviderType() === "custom"}>
                      <span class="text-12-regular text-text-weak">
                        The current provider may not support the models below. Check your provider documentation.
                      </span>
                    </Show>
                  </div>
                  <Show when={loadingModels()}>
                    <span class="text-13-regular text-text-weak italic">Loading models...</span>
                  </Show>
                  <Show when={!loadingModels() && embeddingModelOptions().length > 0 && !useManualModel()}>
                    <Select
                      options={[...embeddingModelOptions(), "__manual__"]}
                      current={newModel()}
                      value={(id) => id}
                      label={(id) =>
                        id === "__manual__"
                          ? "Enter manually..."
                          : labelResolvedEmbeddingModel(
                              id,
                              resolvedModels(),
                              selectedProviderID(),
                              connected(),
                              knowledge.models(),
                            )
                      }
                      onSelect={(id) => {
                        if (id === "__manual__") {
                          setUseManualModel(true)
                          setNewModel("")
                        } else if (id) setNewModel(id)
                      }}
                      variant="secondary"
                      size="small"
                      class="w-64"
                    />
                  </Show>
                  <Show when={!loadingModels() && (embeddingModelOptions().length === 0 || useManualModel())}>
                    <div class="flex flex-col gap-1.5 max-w-xs">
                      <input
                        type="text"
                        value={newModel()}
                        onInput={(e) => setNewModel(e.currentTarget.value)}
                        placeholder="text-embedding-3-small"
                        class="h-9 flex-1 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                      />
                      <Show when={useManualModel() && embeddingModelOptions().length > 0}>
                        <button
                          type="button"
                          onClick={() => {
                            setUseManualModel(false)
                            if (newModel() && !embeddingModelOptions().includes(newModel())) {
                              setNewModel(embeddingModelOptions()[0] ?? "")
                            }
                          }}
                          class="text-12-regular text-text-weak hover:text-text-base underline self-start"
                        >
                          Use model list
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Chunk Size */}
              <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base">
                <div class="flex flex-col min-w-0 flex-1">
                  <span class="text-14-medium text-text-strong">Chunk Size</span>
                </div>
                <input
                  type="number"
                  value={newChunkSize()}
                  onInput={(e) => setNewChunkSize(parseInt(e.currentTarget.value) || 500)}
                  class="h-9 w-32 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus"
                />
              </div>

              {/* Chunk Overlap */}
              <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3">
                <div class="flex flex-col min-w-0 flex-1">
                  <span class="text-14-medium text-text-strong">Chunk Overlap</span>
                </div>
                <input
                  type="number"
                  value={newChunkOverlap()}
                  onInput={(e) => setNewChunkOverlap(parseInt(e.currentTarget.value) || 50)}
                  class="h-9 w-32 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus"
                />
              </div>
            </div>

            <Button
              variant="primary"
              onClick={handleAddKnowledgeBase}
              disabled={!newPath() || syncing() === "new"}
              class="w-fit mt-2"
            >
              {syncing() === "new" ? "Adding..." : "Add & Sync"}
            </Button>
          </div>
        </Show>

        <Show when={knowledge.syncProgress()}>
          {(progress) => (
            <div class="flex flex-col gap-1.5">
              <div class="flex justify-between items-center text-12-regular text-text-base">
                <span>Processing documents...</span>
                <div class="flex items-center gap-2">
                  <span>
                    {progress().current} / {progress().total}
                  </span>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => knowledge.stopSync()}
                    class="h-6 px-2 text-text-error"
                    title="Stop embedding"
                  >
                    <Icon name="stop" class="size-3" />
                  </Button>
                </div>
              </div>
              <div class="h-1.5 w-full rounded-full bg-surface-raised overflow-hidden">
                <div
                  class="h-full rounded-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${Math.round((progress().current / progress().total) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </Show>

        <Show when={error()}>
          <div class="flex items-start gap-2 text-13-regular text-text-error bg-surface-error/10 rounded p-2">
            <Icon name="circle-x" class="size-4 shrink-0 mt-0.5" />
            <span>{error()}</span>
          </div>
        </Show>

        <Show when={success()}>
          <div class="flex items-start gap-2 text-13-regular text-text-success bg-surface-success/10 rounded p-2">
            <Icon name="check" class="size-4 shrink-0 mt-0.5" />
            <span>{success()}</span>
          </div>
        </Show>
      </div>
    </div>
  )
}
