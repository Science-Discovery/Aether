import { Component, Show, createMemo, createSignal, For, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useKnowledge } from "@/context/knowledge"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useProviders } from "@/hooks/use-providers"
import { DialogSelectDirectory } from "./dialog-select-directory"

function toEmbeddingProvider(id: string): "openai" | "local" | "custom" {
  if (id === "local") return "local"
  if (id === "openai") return "openai"
  return "custom"
}

export const KnowledgeDialog: Component = () => {
  const knowledge = useKnowledge()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const server = useServer()
  const providers = useProviders()

  const [syncing, setSyncing] = createSignal(false)
  const [error, setError] = createSignal("")
  const [success, setSuccess] = createSignal("")
  const [showAddForm, setShowAddForm] = createSignal(false)

  const [newPath, setNewPath] = createSignal("")
  const [newName, setNewName] = createSignal("My Knowledge Base")
  const [selectedProviderID, setSelectedProviderID] = createSignal("")
  const [newModel, setNewModel] = createSignal("")
  const [newApiKey, setNewApiKey] = createSignal("")
  const [newBaseURL, setNewBaseURL] = createSignal("")

  const [embeddingModelOptions, setEmbeddingModelOptions] = createSignal<string[]>([])
  const [loadingModels, setLoadingModels] = createSignal(false)
  const [useManualModel, setUseManualModel] = createSignal(false)

  const providerOptions = createMemo(() => ["local", ...providers.connected().map((p) => p.id)])

  const localModels = createMemo(() =>
    knowledge.models().filter((m) => m.provider === "local").map((m) => m.id),
  )

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
    return resp.json() as Promise<{ apiKey: string; baseURL: string; embeddingModels: string[] }>
  }

  const handleProviderSelect = async (id: string | undefined) => {
    if (!id) return
    setSelectedProviderID(id)
    setEmbeddingModelOptions([])
    setUseManualModel(false)
    setNewModel("")
    setNewApiKey("")
    setNewBaseURL("")

    if (id === "local") {
      const models = localModels()
      setEmbeddingModelOptions(models)
      if (models.length > 0) setNewModel(models[0])
      else setUseManualModel(true)
      return
    }

    setLoadingModels(true)
    try {
      const data = await fetchProviderConnection(id)
      if (data.baseURL) setNewBaseURL(data.baseURL)
      if (data.apiKey) setNewApiKey(data.apiKey)
      setEmbeddingModelOptions(data.embeddingModels)
      if (data.embeddingModels.length > 0) setNewModel(data.embeddingModels[0])
      else setUseManualModel(true)
    } catch {
      setUseManualModel(true)
    } finally {
      setLoadingModels(false)
    }
  }

  onMount(() => {
    const last = knowledge.getLastConfig()
    if (last?.provider) {
      handleProviderSelect(last.provider)
      // 覆盖 handleProviderSelect 设置的 model，用上次保存的值
      setTimeout(() => { if (last.model) setNewModel(last.model) }, 0)
    }
    knowledge.refreshAllStats()
  })

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
    if (selectedProviderID() !== "local" && !newBaseURL()) {
      setError("Could not resolve provider API URL. Please check your provider configuration.")
      return
    }

    setSyncing(true)
    try {
      const id = knowledge.addKnowledgeBase({
        path: newPath(),
        name: newName(),
        embeddingProvider: toEmbeddingProvider(selectedProviderID()),
        embeddingModel: newModel(),
        apiKey: newApiKey(),
        baseURL: newBaseURL(),
        chunkSize: 500,
        chunkOverlap: 50,
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

      knowledge.saveLastConfig({
        provider: selectedProviderID(),
        model: newModel(),
        apiKey: newApiKey(),
        baseURL: newBaseURL(),
        dimensions: 1536,
      })

      if (result.errors && result.errors.length > 0) {
        setError(`Synced with ${result.errors.length} errors: ${result.errors.slice(0, 3).join(", ")}`)
      } else {
        setSuccess(`Added ${result.added} documents, updated ${result.updated}`)
      }

      setShowAddForm(false)
      setNewPath("")
      setNewName("My Knowledge Base")
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
    } finally {
      setSyncing(false)
    }
  }

  const handleSync = async (id: string) => {
    setError("")
    setSuccess("")
    setSyncing(true)
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
      setSyncing(false)
    }
  }

  const handleRemove = async (id: string) => {
    if (confirm("Are you sure you want to remove this knowledge base?")) {
      setError("")
      setSuccess("")
      await knowledge.removeKnowledgeBase(id)
    }
  }

  const handleToggle = (id: string) => {
    knowledge.toggleActive(id)
  }

  return (
    <Dialog title="Knowledge Base" class="max-w-lg">
      <div class="flex flex-col gap-4 p-4 max-h-[60vh] overflow-y-auto">
        <Show when={knowledge.knowledgeBases().length > 0}>
          <div class="flex flex-col gap-2">
            <label class="text-13-medium text-text-strong">Knowledge Bases</label>
            <p class="text-12-regular text-text-weak">可选择多个，不选则不使用知识库</p>
            <div class="flex flex-col gap-1">
              <For each={knowledge.knowledgeBases()}>
                {(kb) => {
                  const isActive = () => knowledge.isActive(kb.id)
                  return (
                    <div
                      class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
                      classList={{
                        "border-border-interactive bg-surface-raised-base": isActive(),
                        "border-border-base bg-surface-base hover:bg-surface-raised-base": !isActive(),
                      }}
                      onClick={() => handleToggle(kb.id)}
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
                            <Icon name="check" class="size-3 text-icon-interactive" />
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
                          onClick={(e: MouseEvent) => { e.stopPropagation(); handleSync(kb.id) }}
                          disabled={syncing()}
                          class="h-7 px-2"
                        >
                          <Icon name="arrow-down-to-line" class="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={(e: MouseEvent) => { e.stopPropagation(); handleRemove(kb.id) }}
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
          <Button variant="secondary" size="small" onClick={() => setShowAddForm(true)} class="w-full">
            <Icon name="plus" class="size-4 mr-1" />
            Add Knowledge Base
          </Button>
        </Show>

        <Show when={showAddForm()}>
          <div class="flex flex-col gap-4 p-3 rounded-lg border border-border-base bg-surface-base">
            <div class="flex items-center justify-between">
              <span class="text-14-medium text-text-strong">New Knowledge Base</span>
              <Button variant="ghost" size="small" onClick={() => setShowAddForm(false)} class="h-7 px-2">
                <Icon name="close" class="size-4" />
              </Button>
            </div>

            {/* Folder Path */}
            <div class="flex flex-col gap-2">
              <label class="text-13-medium text-text-strong">Folder Path</label>
              <div class="flex gap-2">
                <input
                  type="text"
                  value={newPath()}
                  onInput={(e) => setNewPath(e.currentTarget.value)}
                  placeholder="/path/to/your/papers"
                  class="h-9 flex-1 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                />
                <Button variant="secondary" size="small" onClick={handleSelectFolder} class="h-9 px-3 shrink-0">
                  <Icon name="folder" class="size-4 mr-1" />
                  Browse
                </Button>
              </div>
            </div>

            {/* Name */}
            <div class="flex flex-col gap-2">
              <label class="text-13-medium text-text-strong">Name</label>
              <input
                type="text"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                placeholder="My Knowledge Base"
                class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
              />
            </div>

            {/* Embedding Provider — from configured providers */}
            <div class="flex flex-col gap-2">
              <label class="text-13-medium text-text-strong">Embedding Provider</label>
              <Select
                options={providerOptions()}
                current={selectedProviderID()}
                value={(id) => id}
                label={(id) => id === "local" ? "Local (offline)" : id}
                onSelect={handleProviderSelect}
                variant="secondary"
                size="small"
                class="w-full"
              />
            </div>

            {/* Embedding Model */}
            <Show when={selectedProviderID()}>
              <div class="flex flex-col gap-2">
                <label class="text-13-medium text-text-strong">Embedding Model</label>
                <Show when={loadingModels()}>
                  <span class="text-13-regular text-text-weak italic">Loading models...</span>
                </Show>
                <Show when={!loadingModels() && embeddingModelOptions().length > 0 && !useManualModel()}>
                  <Select
                    options={[...embeddingModelOptions(), "__manual__"]}
                    current={newModel()}
                    value={(id) => id}
                    label={(id) => id === "__manual__" ? "Enter manually..." : id}
                    onSelect={(id) => {
                      if (id === "__manual__") { setUseManualModel(true); setNewModel("") }
                      else if (id) setNewModel(id)
                    }}
                    variant="secondary"
                    size="small"
                    class="w-full"
                  />
                </Show>
                <Show when={!loadingModels() && (embeddingModelOptions().length === 0 || useManualModel())}>
                  <input
                    type="text"
                    value={newModel()}
                    onInput={(e) => setNewModel(e.currentTarget.value)}
                    placeholder="text-embedding-3-small"
                    class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                  />
                </Show>
              </div>
            </Show>

            <Button
              variant="primary"
              size="small"
              onClick={handleAddKnowledgeBase}
              disabled={!newPath() || syncing()}
              class="w-full"
            >
              {syncing() ? "Adding..." : "Add & Sync"}
            </Button>
          </div>
        </Show>

        <Show when={syncing() && knowledge.syncProgress()}>
          {(progress) => (
            <div class="flex flex-col gap-1.5">
              <div class="flex justify-between items-center text-12-regular text-text-base">
                <span>Processing documents...</span>
                <div class="flex items-center gap-2">
                  <span>{progress().current} / {progress().total}</span>
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
    </Dialog>
  )
}
