import { Component, Show, createMemo, createSignal, For, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useKnowledge } from "@/context/knowledge"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useProviders } from "@/hooks/use-providers"
import {
  inferKnowledgeProviderID,
  labelEmbeddingModel,
  labelProvider,
  listEmbeddingModels,
  toEmbeddingProvider,
} from "@/utils/knowledge-embedding"
import { DialogSelectDirectory } from "./dialog-select-directory"

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
  const [editId, setEditId] = createSignal("")
  const [editProviderID, setEditProviderID] = createSignal("")
  const [editModel, setEditModel] = createSignal("")
  const [editApiKey, setEditApiKey] = createSignal("")
  const [editBaseURL, setEditBaseURL] = createSignal("")
  const [editModelOptions, setEditModelOptions] = createSignal<string[]>([])
  const [editLoadingModels, setEditLoadingModels] = createSignal(false)
  const [useManualEditModel, setUseManualEditModel] = createSignal(false)
  const [addPath, setAddPath] = createSignal("")
  const [docs, setDocs] = createStore<
    Record<
      string,
      Array<{
        id: string
        fileName: string
        filePath: string
        fileSize: number
        status: string
      }>
    >
  >({})

  const [newPath, setNewPath] = createSignal("")
  const [newName, setNewName] = createSignal("My Knowledge Base")
  const [selectedProviderID, setSelectedProviderID] = createSignal("")
  const [newModel, setNewModel] = createSignal("")
  const [newApiKey, setNewApiKey] = createSignal("")
  const [newBaseURL, setNewBaseURL] = createSignal("")

  const [embeddingModelOptions, setEmbeddingModelOptions] = createSignal<string[]>([])
  const [loadingModels, setLoadingModels] = createSignal(false)
  const [useManualModel, setUseManualModel] = createSignal(false)
  let addRun = 0
  let editRun = 0

  const connected = createMemo(() => providers.connected())
  const providerOptions = createMemo(() => ["local", ...connected().map((p) => p.id)])

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

  const setAddModels = (id: string, extra: string[] = [], pick?: string) => {
    const list = Array.from(
      new Set([
        ...listEmbeddingModels(
          id,
          connected(),
          knowledge.models(),
        ),
        ...extra,
      ]),
    )
    setEmbeddingModelOptions(list)

    if (pick) {
      if (list.includes(pick)) {
        setUseManualModel(false)
        setNewModel(pick)
        return
      }
      setUseManualModel(true)
      setNewModel(pick)
      return
    }

    if (list.length > 0) {
      setUseManualModel(false)
      setNewModel(list[0]!)
      return
    }

    setUseManualModel(true)
    setNewModel("")
  }

  const setEditModels = (id: string, extra: string[] = [], pick?: string) => {
    const list = Array.from(
      new Set([
        ...listEmbeddingModels(
          id,
          connected(),
          knowledge.models(),
        ),
        ...extra,
      ]),
    )
    setEditModelOptions(list)

    if (pick) {
      if (list.includes(pick)) {
        setUseManualEditModel(false)
        setEditModel(pick)
        return
      }
      setUseManualEditModel(true)
      setEditModel(pick)
      return
    }

    if (list.length > 0) {
      setUseManualEditModel(false)
      setEditModel(list[0]!)
      return
    }

    setUseManualEditModel(true)
    setEditModel("")
  }

  const handleProviderSelect = async (id: string | undefined, pick?: string) => {
    if (!id) return
    const cur = ++addRun
    setSelectedProviderID(id)
    setLoadingModels(id !== "local")
    setNewApiKey("")
    setNewBaseURL("")
    setAddModels(id, [], pick)

    if (id === "local") {
      return
    }

    try {
      const data = await fetchProviderConnection(id)
      if (cur !== addRun) return
      if (data.baseURL) setNewBaseURL(data.baseURL)
      if (data.apiKey) setNewApiKey(data.apiKey)
      setAddModels(id, data.embeddingModels, pick)
    } catch {
      if (cur !== addRun) return
    } finally {
      if (cur === addRun) setLoadingModels(false)
    }
  }

  const handleEditProviderSelect = async (id: string | undefined, pick?: string) => {
    if (!id) return
    const cur = ++editRun
    setEditProviderID(id)
    setEditLoadingModels(id !== "local")
    setEditApiKey("")
    setEditBaseURL("")
    setEditModels(id, [], pick)

    if (id === "local") {
      return
    }

    try {
      const data = await fetchProviderConnection(id)
      if (cur !== editRun) return
      if (data.baseURL) setEditBaseURL(data.baseURL)
      if (data.apiKey) setEditApiKey(data.apiKey)
      setEditModels(id, data.embeddingModels, pick)
    } catch {
      if (cur !== editRun) return
    } finally {
      if (cur === editRun) setEditLoadingModels(false)
    }
  }

  onMount(() => {
    const last = knowledge.getLastConfig()
    if (last?.provider) {
      void handleProviderSelect(last.provider, last.model)
    }
    void knowledge.refreshAllStats()
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
    if (toEmbeddingProvider(selectedProviderID()) === "custom" && !newBaseURL()) {
      setError("Could not resolve provider API URL. Please check your provider configuration.")
      return
    }

    setSyncing(true)
    try {
      const id = knowledge.addKnowledgeBase({
        path: newPath(),
        name: newName(),
        providerID: selectedProviderID(),
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
        dimensions: knowledge.models().find((item) => item.id === newModel())?.dimensions ?? 1536,
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

  const openEditor = async (id: string) => {
    const kb = knowledge.knowledgeBases().find((item) => item.id === id)
    if (!kb) return
    setEditId(id)
    const providerID = inferKnowledgeProviderID(
      kb,
      connected(),
      knowledge.models(),
    )
    if (providerID) {
      await handleEditProviderSelect(providerID, kb.embeddingModel)
    } else {
      setEditProviderID("")
      setEditApiKey(kb.apiKey || "")
      setEditBaseURL(kb.baseURL || "")
      setEditModels("", [], kb.embeddingModel)
    }
    try {
      const list = await knowledge.listDocuments(id)
      setDocs(
        id,
        list.map((item) => ({
          id: item.id,
          fileName: item.fileName,
          filePath: item.filePath,
          fileSize: item.fileSize,
          status: item.status,
        })),
      )
    } catch {
      setDocs(id, [])
    }
  }

  const closeEditor = () => {
    setEditId("")
  }

  const handleUpdateConfig = async () => {
    const id = editId()
    if (!id) return
    setError("")
    setSuccess("")

    if (!editProviderID()) {
      setError("Please select an embedding provider")
      return
    }
    if (!editModel()) {
      setError("Please select or enter an embedding model")
      return
    }
    if (toEmbeddingProvider(editProviderID()) === "openai" && !editApiKey()) {
      setError("Please enter your OpenAI API key")
      return
    }
    if (toEmbeddingProvider(editProviderID()) === "custom" && (!editApiKey() || !editBaseURL())) {
      setError("Please enter custom API URL and API Key")
      return
    }

    setSyncing(true)
    try {
      await knowledge.updateEmbeddingConfig(id, {
        embeddingProvider: toEmbeddingProvider(editProviderID()),
        embeddingModel: editModel(),
        apiKey: editApiKey(),
        baseURL: editBaseURL(),
      })
      knowledge.updateKnowledgeBase(id, {
        providerID: editProviderID(),
      })
      const list = await knowledge.listDocuments(id)
      setDocs(
        id,
        list.map((item) => ({
          id: item.id,
          fileName: item.fileName,
          filePath: item.filePath,
          fileSize: item.fileSize,
          status: item.status,
        })),
      )
      setSuccess("Embedding config updated. Click sync to rebuild index with the new model.")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
    } finally {
      setSyncing(false)
    }
  }

  const handleRemoveDocument = async (kbId: string, docId: string) => {
    setError("")
    setSuccess("")
    try {
      await knowledge.removeDocument(kbId, docId)
      setDocs(
        kbId,
        (docs[kbId] || []).filter((item) => item.id !== docId),
      )
      setSuccess("Document removed from knowledge base")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
    }
  }

  const handleImportDocument = async (kbId: string) => {
    setError("")
    setSuccess("")
    if (!addPath()) {
      setError("Please enter a file path")
      return
    }

    setSyncing(true)
    try {
      const result = await knowledge.importDocument(kbId, addPath())
      if (result.errors.length > 0) {
        setError(result.errors.slice(0, 2).join(", "))
      }
      if (result.added > 0) {
        await handleSync(kbId)
      }
      const list = await knowledge.listDocuments(kbId)
      setDocs(
        kbId,
        list.map((item) => ({
          id: item.id,
          fileName: item.fileName,
          filePath: item.filePath,
          fileSize: item.fileSize,
          status: item.status,
        })),
      )
      if (result.added > 0) {
        setSuccess("File imported and indexed")
      }
      setAddPath("")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
    } finally {
      setSyncing(false)
    }
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
                  const isEdit = () => editId() === kb.id
                  return (
                    <div class="flex flex-col gap-2">
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
                            title="Sync new files"
                          >
                            <Icon name="arrow-down-to-line" class="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="small"
                            onClick={(e: MouseEvent) => {
                              e.stopPropagation()
                              if (isEdit()) {
                                closeEditor()
                                return
                              }
                              openEditor(kb.id)
                            }}
                            class="h-7 px-2"
                            title="Edit knowledge base"
                          >
                            <Icon name="edit" class="size-3.5" />
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

                      <Show when={isEdit()}>
                        <div class="rounded-lg border border-border-base bg-surface-base p-3 flex flex-col gap-3">
                          <div class="text-13-medium text-text-strong">Edit Knowledge Base</div>
                          <p class="text-12-regular text-text-weak">
                            To add new files, put files into this folder and click sync.
                          </p>

                          <div class="grid grid-cols-1 gap-2">
                            <label class="text-12-regular text-text-base">Embedding Provider</label>
                            <Select
                              options={providerOptions()}
                              current={editProviderID()}
                              value={(id) => id}
                              label={(id) => labelProvider(id, connected())}
                              onSelect={(id) => void handleEditProviderSelect(id)}
                              variant="secondary"
                              size="small"
                              class="w-full"
                            />
                          </div>

                          <div class="grid grid-cols-1 gap-2">
                            <label class="text-12-regular text-text-base">Embedding Model</label>
                            <Show when={editLoadingModels()}>
                              <span class="text-12-regular text-text-weak italic">Loading models...</span>
                            </Show>
                            <Show when={!editLoadingModels() && editModelOptions().length > 0 && !useManualEditModel()}>
                              <Select
                                options={[...editModelOptions(), "__manual__"]}
                                current={editModel()}
                                value={(id) => id}
                                label={(id) =>
                                  id === "__manual__"
                                    ? "Enter manually..."
                                    : labelEmbeddingModel(id, editProviderID(), connected(), knowledge.models())
                                }
                                onSelect={(id) => {
                                  if (id === "__manual__") {
                                    setUseManualEditModel(true)
                                    setEditModel("")
                                    return
                                  }
                                  if (id) setEditModel(id)
                                }}
                                variant="secondary"
                                size="small"
                                class="w-full"
                              />
                            </Show>
                            <Show when={!editLoadingModels() && (editModelOptions().length === 0 || useManualEditModel())}>
                              <input
                                type="text"
                                value={editModel()}
                                onInput={(e) => setEditModel(e.currentTarget.value)}
                                class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong"
                              />
                            </Show>
                          </div>

                          <Show
                            when={
                              !!editProviderID() &&
                              (toEmbeddingProvider(editProviderID()) === "openai" ||
                                toEmbeddingProvider(editProviderID()) === "custom")
                            }
                          >
                            <div class="grid grid-cols-1 gap-2">
                              <label class="text-12-regular text-text-base">API Key</label>
                              <input
                                type="password"
                                value={editApiKey()}
                                onInput={(e) => setEditApiKey(e.currentTarget.value)}
                                class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong"
                              />
                            </div>
                          </Show>

                          <Show when={!!editProviderID() && toEmbeddingProvider(editProviderID()) === "custom"}>
                            <div class="grid grid-cols-1 gap-2">
                              <label class="text-12-regular text-text-base">API URL</label>
                              <input
                                type="text"
                                value={editBaseURL()}
                                onInput={(e) => setEditBaseURL(e.currentTarget.value)}
                                class="h-9 w-full rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong"
                              />
                            </div>
                          </Show>

                          <div class="flex items-center gap-2">
                            <Button variant="secondary" size="small" onClick={handleUpdateConfig} disabled={syncing()}>
                              Update Embedding Config
                            </Button>
                            <Button variant="ghost" size="small" onClick={() => handleSync(kb.id)} disabled={syncing()}>
                              Sync Now
                            </Button>
                          </div>

                          <div class="flex flex-col gap-2">
                            <div class="text-12-medium text-text-strong">Add File</div>
                            <div class="flex gap-2">
                              <input
                                type="text"
                                value={addPath()}
                                onInput={(e) => setAddPath(e.currentTarget.value)}
                                placeholder="/absolute/path/to/file.md"
                                class="h-9 flex-1 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong"
                              />
                              <Button
                                variant="secondary"
                                size="small"
                                onClick={() => handleImportDocument(kb.id)}
                                disabled={syncing()}
                                class="h-9"
                              >
                                Add
                              </Button>
                            </div>
                          </div>

                          <div class="flex flex-col gap-2">
                            <div class="text-12-medium text-text-strong">Indexed Documents</div>
                            <Show
                              when={(docs[kb.id] || []).length > 0}
                              fallback={<div class="text-12-regular text-text-weak">No indexed documents.</div>}
                            >
                              <div class="flex flex-col gap-1 max-h-40 overflow-y-auto">
                                <For each={docs[kb.id] || []}>
                                  {(item) => (
                                    <div class="flex items-center gap-2 rounded border border-border-base px-2 py-1.5">
                                      <div class="min-w-0 flex-1">
                                        <div class="text-12-medium text-text-strong truncate">{item.fileName}</div>
                                        <div class="text-11-regular text-text-weak truncate">{item.filePath}</div>
                                      </div>
                                      <Button
                                        variant="ghost"
                                        size="small"
                                        class="h-6 px-2 text-text-error"
                                        onClick={() => handleRemoveDocument(kb.id, item.id)}
                                      >
                                        <Icon name="trash" class="size-3" />
                                      </Button>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </Show>
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
                label={(id) => labelProvider(id, connected())}
                onSelect={(id) => void handleProviderSelect(id)}
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
                    label={(id) =>
                      id === "__manual__"
                        ? "Enter manually..."
                        : labelEmbeddingModel(id, selectedProviderID(), connected(), knowledge.models())
                    }
                    onSelect={(id) => {
                      if (id === "__manual__") {
                        setUseManualModel(true)
                        setNewModel("")
                      } else if (id) setNewModel(id)
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
