import { Component, Show, createMemo, createSignal, For, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useKnowledge } from "@/context/knowledge"
import { DialogSelectDirectory } from "./dialog-select-directory"

export const KnowledgeDialog: Component = () => {
  const knowledge = useKnowledge()
  const dialog = useDialog()

  const [syncing, setSyncing] = createSignal(false)
  const [error, setError] = createSignal("")
  const [success, setSuccess] = createSignal("")
  const [showAddForm, setShowAddForm] = createSignal(false)

  const getLastConfigDefaults = (): {
    provider: "openai" | "local" | "custom"
    model: string
    apiKey: string
    baseURL: string
    dimensions: number
  } => {
    const last = knowledge.getLastConfig()
    if (last) {
      return {
        provider: last.provider,
        model: last.model,
        apiKey: last.apiKey,
        baseURL: last.baseURL,
        dimensions: last.dimensions,
      }
    }
    return {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "",
      baseURL: "",
      dimensions: 1536,
    }
  }

  const [newPath, setNewPath] = createSignal("")
  const [newName, setNewName] = createSignal("My Knowledge Base")
  const [newProvider, setNewProvider] = createSignal<"openai" | "local" | "custom">("openai")
  const [newModel, setNewModel] = createSignal("text-embedding-3-small")
  const [newApiKey, setNewApiKey] = createSignal("")
  const [newBaseURL, setNewBaseURL] = createSignal("")

  onMount(() => {
    const defaults = getLastConfigDefaults()
    setNewProvider(defaults.provider)
    setNewModel(defaults.model)
    setNewApiKey(defaults.apiKey)
    setNewBaseURL(defaults.baseURL)
    knowledge.refreshAllStats()
  })

  const models = knowledge.models()

  const providerModels = createMemo(() => {
    const p = newProvider()
    return models.filter((m) => m.provider === p)
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

  const handleProviderChange = (p: string | undefined) => {
    if (!p) return
    const provider = p as "openai" | "local" | "custom"
    const firstModel = models.find((m) => m.provider === provider)
    setNewProvider(provider)
    setNewModel(provider === "custom" ? newModel() : (firstModel?.id ?? ""))
  }

  const handleAddKnowledgeBase = async () => {
    setError("")
    setSuccess("")

    if (!newPath()) {
      setError("Please select a folder")
      return
    }

    if (newProvider() === "openai" && !newApiKey()) {
      setError("Please enter your OpenAI API key")
      return
    }

    if (newProvider() === "custom") {
      if (!newModel()) {
        setError("Please enter the model name")
        return
      }
      if (!newBaseURL()) {
        setError("Please enter the API URL")
        return
      }
      if (!newApiKey()) {
        setError("Please enter the API Key")
        return
      }
    }

    setSyncing(true)
    try {
      const id = knowledge.addKnowledgeBase({
        path: newPath(),
        name: newName(),
        embeddingProvider: newProvider(),
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
        provider: newProvider(),
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
      console.error("Sync error:", e)
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
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            handleSync(kb.id)
                          }}
                          disabled={syncing()}
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

            <div class="flex flex-col gap-2">
              <label class="text-13-medium text-text-strong">Embedding Provider</label>
              <Select
                options={["openai", "local", "custom"]}
                current={newProvider()}
                value={(p) => p}
                label={(p) => (p === "openai" ? "OpenAI" : p === "local" ? "Local" : "Custom")}
                onSelect={handleProviderChange}
                variant="secondary"
                size="small"
                class="w-full"
              />
            </div>

            <Show when={newProvider() === "openai" || newProvider() === "local"}>
              <div class="flex flex-col gap-2">
                <label class="text-13-medium text-text-strong">Embedding Model</label>
                <Select
                  options={providerModels().map((m) => m.id)}
                  current={newModel()}
                  value={(id) => id}
                  label={(id) => models.find((m) => m.id === id)?.name ?? id}
                  onSelect={(id) => id && setNewModel(id)}
                  variant="secondary"
                  size="small"
                  class="w-full"
                />
              </div>
            </Show>

            <Show when={newProvider() === "openai"}>
              <div class="flex flex-col gap-2">
                <label class="text-13-medium text-text-strong">OpenAI API Key</label>
                <input
                  type="password"
                  value={newApiKey()}
                  onInput={(e) => setNewApiKey(e.currentTarget.value)}
                  placeholder="sk-..."
                  class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                />
              </div>
            </Show>

            <Show when={newProvider() === "custom"}>
              <div class="flex flex-col gap-3 p-3 rounded-md border border-border-base bg-surface-base/50">
                <div class="text-13-medium text-text-strong">Custom Embedding Configuration</div>

                <div class="flex flex-col gap-2">
                  <label class="text-12-regular text-text-base">API URL</label>
                  <input
                    type="text"
                    value={newBaseURL()}
                    onInput={(e) => setNewBaseURL(e.currentTarget.value)}
                    placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
                    class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                  />
                </div>

                <div class="flex flex-col gap-2">
                  <label class="text-12-regular text-text-base">API Key</label>
                  <input
                    type="password"
                    value={newApiKey()}
                    onInput={(e) => setNewApiKey(e.currentTarget.value)}
                    placeholder="your-api-key"
                    class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                  />
                </div>

                <div class="flex flex-col gap-2">
                  <label class="text-12-regular text-text-base">Model Name</label>
                  <input
                    type="text"
                    value={newModel()}
                    onInput={(e) => setNewModel(e.currentTarget.value)}
                    placeholder="text-embedding-3-small"
                    class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
                  />
                </div>
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
    </Dialog>
  )
}
