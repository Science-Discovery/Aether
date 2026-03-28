/**
 * 批量 Markdown 翻译对话框
 *
 * 对多个 Markdown 文件使用相同的设置（模型、冲突策略）进行批量翻译。
 * 按顺序逐个启动，共用进度条。
 */

import { type Component, Show, For, createSignal, createMemo, onMount } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useModels } from "@/context/models"
import { ModelSelectorPopover } from "./dialog-select-model"
import { registerConvertTask, updateConvertTask, triggerOpenFile, triggerRefreshDir, registerEventSource } from "./pdf-convert-progress"

// 复用翻译设置持久化
const STORAGE_KEY = "translate-markdown-settings"

type TranslateSettings = {
  model?: ModelKey
  autoOpen: boolean
  conflictAction: "replace" | "rename"
}

function loadSettings(): TranslateSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { autoOpen: true, conflictAction: "replace", ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { autoOpen: true, conflictAction: "replace" }
}

function saveSettings(s: Partial<TranslateSettings>) {
  try {
    const current = loadSettings()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...s }))
  } catch { /* ignore */ }
}

type ModelKey = { providerID: string; modelID: string }
const _initSettings = loadSettings()
const [_batchTransModelKey, _setBatchTransModelKey] = createSignal<ModelKey | undefined>(_initSettings.model)
let _batchTransModelInitialized = !!_initSettings.model

function getBatchTransModelKey() { return _batchTransModelKey() }
function setBatchTransModelKey(key: ModelKey | undefined) {
  _batchTransModelInitialized = true
  _setBatchTransModelKey(key)
  saveSettings({ model: key })
}

export const DialogBatchTranslateMarkdown: Component<{
  mdPaths: string[]
}> = (props) => {
  const dialogCtx = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  const server = useServer()
  const models = useModels()

  const [autoOpen, setAutoOpen] = createSignal(loadSettings().autoOpen)
  const [conflictAction, setConflictAction] = createSignal<"replace" | "rename">(loadSettings().conflictAction)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [starting, setStarting] = createSignal(false)
  const [fileInfos, setFileInfos] = createSignal<{ path: string; name: string; chunkCount: number; hasDataJson: boolean }[]>([])

  const fetchApi = async (urlPath: string, options: RequestInit = {}): Promise<Response> => {
    const baseUrl = sdk.url
    const s = server.current?.http
    const authHeader: Record<string, string> = s?.password
      ? { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
      : {}
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...authHeader,
      ...(options.headers as Record<string, string> ?? {}),
    }
    const separator = urlPath.includes("?") ? "&" : "?"
    return fetch(`${baseUrl}${urlPath}${separator}directory=${encodeURIComponent(sdk.directory)}`, {
      ...options,
      headers,
    })
  }

  onMount(async () => {
    setLoading(true)
    try {
      const results = await Promise.all(
        props.mdPaths.map(async (p) => {
          const res = await fetchApi(`/file/translate-markdown/check?path=${encodeURIComponent(p)}`)
          if (!res.ok) {
            const err = await res.json()
            throw new Error(err.error || `检查 ${p.split("/").pop()} 失败`)
          }
          const data = await res.json()
          return {
            path: p,
            name: p.split("/").pop() || p,
            chunkCount: data.chunkCount as number,
            hasDataJson: data.hasDataJson as boolean,
          }
        }),
      )
      setFileInfos(results)
    } catch (e: any) {
      setError(e?.message || "预检查失败")
    } finally {
      setLoading(false)
    }
  })

  if (!_batchTransModelInitialized) {
    const m = local.model.current()
    if (m) _setBatchTransModelKey({ providerID: m.provider.id, modelID: m.id })
    _batchTransModelInitialized = true
  }
  const translateModel = createMemo(() => {
    const key = getBatchTransModelKey()
    if (!key) return undefined
    return models.find(key)
  })
  const translateModelState = {
    ready: models.ready,
    current: translateModel,
    recent: () => models.recent.list().map(models.find).filter(Boolean),
    list: models.list,
    cycle: () => {},
    set: (item: ModelKey | undefined, _options?: { recent?: boolean }) => {
      setBatchTransModelKey(item ? { providerID: item.providerID, modelID: item.modelID } : undefined)
    },
    visible: (item: ModelKey) => models.visible(item),
    setVisibility: (item: ModelKey, visible: boolean) => models.setVisibility(item, visible),
    variant: {
      configured: () => undefined,
      selected: () => undefined,
      current: () => undefined,
      list: () => [] as string[],
      set: () => {},
      cycle: () => {},
    },
  }

  const totalChunks = createMemo(() => fileInfos().reduce((sum, f) => sum + f.chunkCount, 0))

  /** 连接 SSE 并返回一个 Promise，在任务完成/出错时 resolve */
  const connectSSEAndWait = (taskID: string, isLast: boolean): Promise<void> => {
    const MAX_RETRIES = 5
    const RETRY_DELAY = 2000

    const attempt = (retryCount: number): Promise<void> => {
      return new Promise<void>((resolve) => {
        const baseUrl = sdk.url
        const url = `${baseUrl}/file/translate-markdown/progress?taskID=${taskID}&directory=${encodeURIComponent(sdk.directory)}`
        const es = new EventSource(url)
        registerEventSource(es)
        let gotTerminal = false

        const finish = () => {
          es.close()
          resolve()
        }

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            switch (data.type) {
              case "progress":
                updateConvertTask({ currentPage: data.currentPage, totalPages: data.totalPages, phase: data.phase })
                break
              case "token":
                updateConvertTask({ tokenInput: data.input, tokenOutput: data.output })
                break
              case "page_done":
                updateConvertTask({ streamContent: "" })
                break
              case "done":
                gotTerminal = true
                updateConvertTask({ status: "done", outputPath: data.outputPath })
                if (data.outputPath) triggerRefreshDir(data.outputPath)
                if (data.outputPath && isLast) triggerOpenFile(data.outputPath)
                finish()
                break
              case "error":
                if (!data.page) {
                  gotTerminal = true
                  updateConvertTask({ status: "error", error: data.message })
                  finish()
                }
                break
            }
          } catch { /* ignore */ }
        }

        es.onerror = () => {
          if (es.readyState === EventSource.CLOSED) {
            es.close()
            if (gotTerminal) {
              resolve()
            } else if (retryCount < MAX_RETRIES) {
              console.warn(`[batch-translate] SSE closed without terminal event for ${taskID}, retry ${retryCount + 1}/${MAX_RETRIES}`)
              setTimeout(() => resolve(attempt(retryCount + 1)), RETRY_DELAY)
            } else {
              console.error(`[batch-translate] SSE failed after ${MAX_RETRIES} retries for ${taskID}`)
              updateConvertTask({ status: "error", error: "连接中断，请检查任务状态" })
              resolve()
            }
          }
        }
      })
    }

    return attempt(0)
  }

  const handleStart = async () => {
    const model = translateModel()
    if (!model) {
      showToast({ variant: "error", title: "请先选择模型" })
      return
    }

    setStarting(true)
    saveSettings({ autoOpen: autoOpen(), conflictAction: conflictAction() })
    dialogCtx.close()

    try {
      const infos = fileInfos()
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i]
        const isLast = i === infos.length - 1

        const res = await fetchApi("/file/translate-markdown", {
          method: "POST",
          body: JSON.stringify({
            path: info.path,
            providerID: model.provider.id,
            modelID: model.id,
            targetLanguage: "zh-CN",
            conflictAction: conflictAction(),
          }),
        })
        if (!res.ok) {
          const err = await res.json()
          showToast({ variant: "error", title: `${info.name} 启动失败`, description: err.error })
          continue
        }
        const { taskID } = await res.json()

        registerConvertTask(
          {
            taskID,
            pdfPath: info.path,
            status: "running",
            currentPage: 0,
            totalPages: info.chunkCount,
            phase: "translate",
            taskType: "translate",
            cancelUrl: "/file/translate-markdown/cancel",
            batchIndex: i + 1,
            batchTotal: infos.length,
          },
          fetchApi,
          autoOpen() && isLast,
        )

        // 等待当前任务完成后再启动下一个
        await connectSSEAndWait(taskID, isLast)
      }
    } catch (e: any) {
      showToast({ variant: "error", title: "批量启动失败", description: e?.message })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog title={`批量翻译为中文（${props.mdPaths.length} 个文件）`} size="large">
      <div class="flex flex-col gap-4 p-4 max-h-[70vh] overflow-y-auto">
        <Show when={loading()}>
          <div class="text-text-weak text-sm">正在检查文件信息...</div>
        </Show>

        <Show when={error()}>
          <div class="text-red-500 text-sm">{error()}</div>
        </Show>

        <Show when={!loading() && !error() && fileInfos().length > 0}>
          {/* 文件列表 */}
          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium text-text-base">待翻译文件</label>
            <div class="max-h-32 overflow-y-auto rounded-md border border-border-base p-2">
              <For each={fileInfos()}>
                {(info) => (
                  <div class="flex items-center justify-between text-xs py-0.5">
                    <span class="text-text-base truncate">{info.name}</span>
                    <span class="shrink-0 ml-2 text-text-weak">
                      {info.chunkCount} {info.hasDataJson ? "页" : "块"}
                    </span>
                  </div>
                )}
              </For>
            </div>
            <p class="text-xs text-text-weak">共 {totalChunks()} 个翻译单元</p>
          </div>

          {/* 模型选择 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">模型选择</label>
            <p class="text-xs text-text-weak">翻译不需要多模态能力，纯文本模型即可</p>
            <ModelSelectorPopover model={translateModelState}>
              <Button variant="secondary" class="w-full justify-start text-left">
                {translateModel()
                  ? `${translateModel()!.provider.name} / ${translateModel()!.name}`
                  : "选择模型..."}
              </Button>
            </ModelSelectorPopover>
            <div class="p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <p class="text-xs text-yellow-600 dark:text-yellow-400">
                批量翻译会逐个文件排队执行，可能产生较大的 API 费用
              </p>
            </div>
          </div>

          {/* 冲突策略 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">文件冲突处理（对所有文件统一）</label>
            <div class="flex flex-col gap-1">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="batchTransConflict" checked={conflictAction() === "replace"} onChange={() => setConflictAction("replace")} />
                <span class="text-text-base">覆盖已有文件</span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="batchTransConflict" checked={conflictAction() === "rename"} onChange={() => setConflictAction("rename")} />
                <span class="text-text-base">重命名新文件（如 xxx(1).md）</span>
              </label>
            </div>
          </div>

          {/* 自动打开 */}
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={autoOpen()} onChange={(e) => setAutoOpen(e.currentTarget.checked)} />
            <span class="text-text-base">全部完成后自动打开最后一个文件</span>
          </label>

          {/* 操作按钮 */}
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => dialogCtx.close()}>取消</Button>
            <Button onClick={handleStart} disabled={!translateModel() || starting()}>
              {starting() ? "启动中..." : `开始翻译（${fileInfos().length} 个文件）`}
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
