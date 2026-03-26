/**
 * 批量 PDF 转 Markdown 对话框
 *
 * 对多个 PDF 文件使用相同的设置（模型、输出模式、冲突策略）进行批量转换。
 * 按顺序逐个启动，共用同一个进度条。
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
import { registerConvertTask, updateConvertTask, triggerOpenFile, registerEventSource, getCurrentPhase } from "./pdf-convert-progress"

// 复用 PDF 转换的设置持久化
const STORAGE_KEY = "pdf-to-markdown-settings"

type PdfConvertSettings = {
  model?: ModelKey
  outputMode: "merged" | "per-page"
  autoOpen: boolean
  conflictAction: "replace" | "rename"
}

function loadSettings(): PdfConvertSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { outputMode: "merged", autoOpen: true, conflictAction: "replace", ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { outputMode: "merged", autoOpen: true, conflictAction: "replace" }
}

function saveSettings(s: Partial<PdfConvertSettings>) {
  try {
    const current = loadSettings()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...s }))
  } catch { /* ignore */ }
}

type ModelKey = { providerID: string; modelID: string }
const _initSettings = loadSettings()
const [_batchPdfModelKey, _setBatchPdfModelKey] = createSignal<ModelKey | undefined>(_initSettings.model)
let _batchPdfModelInitialized = !!_initSettings.model

function getBatchPdfModelKey() { return _batchPdfModelKey() }
function setBatchPdfModelKey(key: ModelKey | undefined) {
  _batchPdfModelInitialized = true
  _setBatchPdfModelKey(key)
  saveSettings({ model: key })
}

export const DialogBatchPdfConvert: Component<{
  pdfPaths: string[]
}> = (props) => {
  const dialogCtx = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  const server = useServer()
  const models = useModels()

  const [outputMode, setOutputMode] = createSignal<"merged" | "per-page">(loadSettings().outputMode)
  const [autoOpen, setAutoOpen] = createSignal(loadSettings().autoOpen)
  const [conflictAction, setConflictAction] = createSignal<"replace" | "rename">(loadSettings().conflictAction)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [starting, setStarting] = createSignal(false)
  const [pythonAvailable, setPythonAvailable] = createSignal(true)
  const [pythonMissing, setPythonMissing] = createSignal<string[]>([])
  const [fileInfos, setFileInfos] = createSignal<{ path: string; name: string; pageCount: number }[]>([])

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
      const [pyRes, ...pageResults] = await Promise.all([
        fetchApi("/file/pdf-python-check"),
        ...props.pdfPaths.map(async (p) => {
          const res = await fetchApi(`/file/pdf-page-count?path=${encodeURIComponent(p)}`)
          if (!res.ok) throw new Error(`获取 ${p.split("/").pop()} 页数失败`)
          const data = await res.json()
          return { path: p, name: p.split("/").pop() || p, pageCount: data.pageCount as number }
        }),
      ])

      if (pyRes.ok) {
        const pyData = await pyRes.json()
        setPythonAvailable(pyData.available)
        setPythonMissing(pyData.missingDeps ?? [])
      }

      setFileInfos(pageResults)
    } catch (e: any) {
      setError(e?.message || "预检查失败")
    } finally {
      setLoading(false)
    }
  })

  if (!_batchPdfModelInitialized) {
    const m = local.model.current()
    if (m) _setBatchPdfModelKey({ providerID: m.provider.id, modelID: m.id })
    _batchPdfModelInitialized = true
  }
  const pdfModel = createMemo(() => {
    const key = getBatchPdfModelKey()
    if (!key) return undefined
    return models.find(key)
  })
  const pdfModelState = {
    ready: models.ready,
    current: pdfModel,
    recent: () => models.recent.list().map(models.find).filter(Boolean),
    list: models.list,
    cycle: () => {},
    set: (item: ModelKey | undefined, _options?: { recent?: boolean }) => {
      setBatchPdfModelKey(item ? { providerID: item.providerID, modelID: item.modelID } : undefined)
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

  const totalPages = createMemo(() => fileInfos().reduce((sum, f) => sum + f.pageCount, 0))
  const hasOverLimit = createMemo(() => fileInfos().some((f) => f.pageCount > 50))

  const connectSSE = (taskID: string, isLast: boolean) => {
    const baseUrl = sdk.url
    const url = `${baseUrl}/file/pdf-to-markdown/progress?taskID=${taskID}&directory=${encodeURIComponent(sdk.directory)}`
    const es = new EventSource(url)
    registerEventSource(es)

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
          case "done": {
            const finish = () => {
              updateConvertTask({ status: "done", outputPath: data.outputPath })
              es.close()
              if (data.outputPath && isLast) triggerOpenFile(data.outputPath)
            }
            if (getCurrentPhase() === "postqa") setTimeout(finish, 1200)
            else finish()
            break
          }
          case "error":
            if (!data.page) {
              updateConvertTask({ status: "error", error: data.message })
              es.close()
            }
            break
        }
      } catch { /* ignore */ }
    }

    es.onerror = () => es.close()
  }

  const handleStart = async () => {
    const model = pdfModel()
    if (!model) {
      showToast({ variant: "error", title: "请先选择模型" })
      return
    }

    setStarting(true)
    saveSettings({ outputMode: outputMode(), autoOpen: autoOpen(), conflictAction: conflictAction() })

    try {
      const infos = fileInfos()
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i]
        if (info.pageCount > 50) continue

        const res = await fetchApi("/file/pdf-to-markdown", {
          method: "POST",
          body: JSON.stringify({
            path: info.path,
            providerID: model.provider.id,
            modelID: model.id,
            startPage: 1,
            endPage: info.pageCount,
            outputMode: outputMode(),
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
            totalPages: info.pageCount,
            phase: "text",
          },
          fetchApi,
          autoOpen() && i === infos.length - 1,
        )

        connectSSE(taskID, i === infos.length - 1)
      }

      dialogCtx.close()
    } catch (e: any) {
      showToast({ variant: "error", title: "批量启动失败", description: e?.message })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog title={`批量 PDF 转 Markdown（${props.pdfPaths.length} 个文件）`} size="large">
      <div class="flex flex-col gap-4 p-4 max-h-[70vh] overflow-y-auto">
        <Show when={loading()}>
          <div class="text-text-weak text-sm">正在检查文件信息...</div>
        </Show>

        <Show when={error()}>
          <div class="text-red-500 text-sm">{error()}</div>
        </Show>

        <Show when={!loading() && !error() && !pythonAvailable()}>
          <div class="p-3 rounded-md bg-red-500/10 border border-red-500/20">
            <p class="text-red-500 text-sm font-medium">Python 环境不可用，无法进行 PDF 转换。</p>
            <p class="text-red-400 text-xs mt-1">
              缺少依赖：{pythonMissing().join("、") || "Python3、PyMuPDF、Pillow"}
            </p>
          </div>
          <div class="flex justify-end pt-2">
            <Button variant="ghost" onClick={() => dialogCtx.close()}>关闭</Button>
          </div>
        </Show>

        <Show when={!loading() && !error() && pythonAvailable() && fileInfos().length > 0}>
          {/* 文件列表 */}
          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium text-text-base">待转换文件</label>
            <div class="max-h-32 overflow-y-auto rounded-md border border-border-base p-2">
              <For each={fileInfos()}>
                {(info) => (
                  <div class="flex items-center justify-between text-xs py-0.5">
                    <span class="text-text-base truncate">{info.name}</span>
                    <span class={`shrink-0 ml-2 ${info.pageCount > 50 ? "text-red-500" : "text-text-weak"}`}>
                      {info.pageCount} 页{info.pageCount > 50 ? "（超限，将跳过）" : ""}
                    </span>
                  </div>
                )}
              </For>
            </div>
            <p class="text-xs text-text-weak">共 {totalPages()} 页，每个文件将全页转换</p>
          </div>

          {/* 模型选择 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">模型选择</label>
            <p class="text-xs text-text-weak">请选择一个具有多模态（图片理解）能力的模型</p>
            <ModelSelectorPopover model={pdfModelState}>
              <Button variant="secondary" class="w-full justify-start text-left">
                {pdfModel()
                  ? `${pdfModel()!.provider.name} / ${pdfModel()!.name}`
                  : "选择模型..."}
              </Button>
            </ModelSelectorPopover>
            <div class="p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <p class="text-xs text-yellow-600 dark:text-yellow-400">
                批量转换会逐个文件排队执行，可能产生较大的 API 费用
              </p>
            </div>
          </div>

          {/* 输出模式 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">输出模式（对所有文件统一）</label>
            <div class="flex flex-col gap-1">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="batchOutputMode" checked={outputMode() === "merged"} onChange={() => setOutputMode("merged")} />
                <span class="text-text-base">合并为一个 Markdown 文件</span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="batchOutputMode" checked={outputMode() === "per-page"} onChange={() => setOutputMode("per-page")} />
                <span class="text-text-base">每页一个 Markdown 文件</span>
              </label>
            </div>
          </div>

          {/* 冲突策略 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">文件冲突处理（对所有文件统一）</label>
            <div class="flex flex-col gap-1">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="batchConflict" checked={conflictAction() === "replace"} onChange={() => setConflictAction("replace")} />
                <span class="text-text-base">覆盖已有文件</span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="batchConflict" checked={conflictAction() === "rename"} onChange={() => setConflictAction("rename")} />
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
            <Button onClick={handleStart} disabled={!pdfModel() || starting()}>
              {starting() ? "启动中..." : `开始转换（${fileInfos().filter((f) => f.pageCount <= 50).length} 个文件）`}
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
