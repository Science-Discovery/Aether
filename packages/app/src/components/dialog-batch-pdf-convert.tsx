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
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { useModels } from "@/context/models"
import { ModelSelectorPopover } from "./dialog-select-model"
import { OutputDirectory } from "./output-directory"
import {
  registerConvertTask,
  updateConvertTask,
  triggerOpenFile,
  triggerRefreshDir,
  registerEventSource,
  getCurrentPhase,
  taskUrl,
} from "./pdf-convert-progress"

// 复用 PDF 转换的设置持久化
const STORAGE_KEY = "pdf-to-markdown-settings"

type PdfConvertSettings = {
  model?: ModelKey
  outputMode: "merged" | "per-page"
  autoOpen: boolean
  conflictAction: "replace" | "rename"
  outputTarget: "neighbor" | "custom"
  outputDir?: string
}

function loadSettings(): PdfConvertSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw)
      return {
        outputMode: "merged",
        autoOpen: true,
        conflictAction: "replace",
        outputTarget: "neighbor",
        ...JSON.parse(raw),
      }
  } catch {
    /* ignore */
  }
  return { outputMode: "merged", autoOpen: true, conflictAction: "replace", outputTarget: "neighbor" }
}

function saveSettings(s: Partial<PdfConvertSettings>) {
  try {
    const current = loadSettings()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...s }))
  } catch {
    /* ignore */
  }
}

type ModelKey = { providerID: string; modelID: string }
const _initSettings = loadSettings()
const [_batchPdfModelKey, _setBatchPdfModelKey] = createSignal<ModelKey | undefined>(_initSettings.model)
let _batchPdfModelInitialized = !!_initSettings.model

function getBatchPdfModelKey() {
  return _batchPdfModelKey()
}
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
  const language = useLanguage()

  const [outputMode, setOutputMode] = createSignal<"merged" | "per-page">(loadSettings().outputMode)
  const [autoOpen, setAutoOpen] = createSignal(loadSettings().autoOpen)
  const [conflictAction, setConflictAction] = createSignal<"replace" | "rename">(loadSettings().conflictAction)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [starting, setStarting] = createSignal(false)
  const [pythonAvailable, setPythonAvailable] = createSignal(true)
  const [pythonMissing, setPythonMissing] = createSignal<string[]>([])
  const [fileInfos, setFileInfos] = createSignal<{ path: string; name: string; pageCount: number }[]>([])
  const [outputTarget, setOutputTarget] = createSignal<"neighbor" | "custom">(loadSettings().outputTarget)
  const [outputDir, setOutputDir] = createSignal(loadSettings().outputDir ?? "")
  const [outputDirError, setOutputDirError] = createSignal<string | null>(null)

  const fetchApi = async (urlPath: string, options: RequestInit = {}): Promise<Response> => {
    const baseUrl = sdk.url
    const s = server.current?.http
    const authHeader: Record<string, string> = s?.password
      ? { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
      : {}
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...authHeader,
      ...((options.headers as Record<string, string>) ?? {}),
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
    setManyVisibility: (items: ModelKey[], visible: boolean) => models.setManyVisibility(items, visible),
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
  const selectedOutputDir = createMemo(() => {
    if (outputTarget() !== "custom") return
    const value = outputDir().trim()
    if (!value) return
    return value
  })

  /** 连接 SSE 并返回一个 Promise，在任务完成/出错时 resolve */
  const connectSSEAndWait = (taskID: string, isLast: boolean): Promise<void> => {
    const MAX_RETRIES = 5
    const RETRY_DELAY = 2000

    const attempt = (retryCount: number): Promise<void> => {
      return new Promise<void>((resolve) => {
        const baseUrl = sdk.url
        const url = taskUrl(baseUrl, "/file/pdf-to-markdown/progress", taskID, sdk.directory, server.current?.http)
        const es = new EventSource(url)
        registerEventSource(es)
        let gotTerminal = false // 收到了 done 或 fatal error

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
              case "done": {
                gotTerminal = true
                const doFinish = () => {
                  updateConvertTask({ status: "done", outputPath: data.outputPath })
                  if (data.outputPath) triggerRefreshDir(data.outputPath)
                  if (data.outputPath && isLast) triggerOpenFile(data.outputPath)
                  finish()
                }
                if (getCurrentPhase() === "postqa") setTimeout(doFinish, 1200)
                else doFinish()
                break
              }
              case "error":
                if (!data.page) {
                  gotTerminal = true
                  updateConvertTask({ status: "error", error: data.message })
                  finish()
                }
                break
            }
          } catch {
            /* ignore */
          }
        }

        es.onerror = () => {
          if (es.readyState === EventSource.CLOSED) {
            es.close()
            if (gotTerminal) {
              // 已收到终态事件，正常结束
              resolve()
            } else if (retryCount < MAX_RETRIES) {
              // 未收到终态事件就断开了，重试（服务端会重放历史事件）
              console.warn(
                `[batch-pdf] SSE closed without terminal event for ${taskID}, retry ${retryCount + 1}/${MAX_RETRIES}`,
              )
              setTimeout(() => resolve(attempt(retryCount + 1)), RETRY_DELAY)
            } else {
              console.error(`[batch-pdf] SSE failed after ${MAX_RETRIES} retries for ${taskID}`)
              updateConvertTask({ status: "error", error: "连接中断，请检查任务状态" })
              resolve()
            }
          }
          // readyState === CONNECTING 时是自动重连，不要关闭
        }
      })
    }

    return attempt(0)
  }

  const handleStart = async () => {
    const model = pdfModel()
    if (!model) {
      showToast({ variant: "error", title: "请先选择模型" })
      return
    }
    setOutputDirError(null)
    if (outputTarget() === "custom") {
      const value = outputDir().trim()
      if (!value) {
        setOutputDirError("路径必须指向一个文件夹")
        return
      }
      const check = await fetchApi(`/file/check-directory?path=${encodeURIComponent(value)}`)
      if (!check.ok) {
        setOutputDirError("路径必须指向一个文件夹")
        return
      }
    }

    setStarting(true)
    saveSettings({
      outputMode: outputMode(),
      autoOpen: autoOpen(),
      conflictAction: conflictAction(),
      outputTarget: outputTarget(),
      outputDir: outputDir().trim() || undefined,
    })
    dialogCtx.close()

    try {
      const infos = fileInfos().filter((f) => f.pageCount <= 50)

      // 第一步：一次性将所有 PDF 提交到后端队列
      // 这样即使页面关闭，后端也已持有全部任务，不会中断
      const submitted: { taskID: string; info: (typeof infos)[number]; index: number }[] = []
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i]
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
            outputDir: selectedOutputDir(),
          }),
        })
        if (!res.ok) {
          const err = await res.json()
          if (err.error === "路径必须指向一个文件夹") {
            setOutputDirError(err.error)
            return
          }
          showToast({
            variant: "error",
            title: language.t("batchPdfConvert.startFailed", { name: info.name }),
            description: formatServerError(err.error, language.t),
          })
          continue
        }
        const { taskID } = await res.json()
        submitted.push({ taskID, info, index: i })
      }

      if (submitted.length === 0) return

      // 第二步：逐个连接 SSE 跟踪进度（仅用于 UI 显示，不影响后端执行）
      for (let j = 0; j < submitted.length; j++) {
        const { taskID, info, index } = submitted[j]
        const isLast = j === submitted.length - 1

        registerConvertTask(
          {
            taskID,
            pdfPath: info.path,
            status: "running",
            currentPage: 0,
            totalPages: info.pageCount,
            phase: "text",
            batchIndex: index + 1,
            batchTotal: infos.length,
          },
          fetchApi,
          autoOpen() && isLast,
        )

        await connectSSEAndWait(taskID, isLast)
      }
    } catch (e: any) {
      showToast({ variant: "error", title: "批量启动失败", description: e?.message })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog title={`批量 PDF 转 Markdown（${props.pdfPaths.length} 个文件）`} size="large" persistent>
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
            <Button variant="ghost" onClick={() => dialogCtx.close()}>
              关闭
            </Button>
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
                {pdfModel() ? `${pdfModel()!.provider.name} / ${pdfModel()!.name}` : "选择模型..."}
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
                <input
                  type="radio"
                  name="batchOutputMode"
                  checked={outputMode() === "merged"}
                  onChange={() => setOutputMode("merged")}
                />
                <span class="text-text-base">合并为一个 Markdown 文件</span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="batchOutputMode"
                  checked={outputMode() === "per-page"}
                  onChange={() => setOutputMode("per-page")}
                />
                <span class="text-text-base">每页一个 Markdown 文件</span>
              </label>
            </div>
          </div>

          <OutputDirectory
            label="输出位置（对所有文件统一）"
            title="选择批量 PDF 转换输出文件夹"
            name="batchPdfOutputTarget"
            neighbor="保存在各自 PDF 文件旁边"
            custom="统一保存到指定文件夹"
            target={outputTarget}
            setTarget={setOutputTarget}
            value={outputDir}
            setValue={setOutputDir}
            error={outputDirError}
            setError={setOutputDirError}
          />

          {/* 冲突策略 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">文件冲突处理（对所有文件统一）</label>
            <div class="flex flex-col gap-1">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="batchConflict"
                  checked={conflictAction() === "replace"}
                  onChange={() => setConflictAction("replace")}
                />
                <span class="text-text-base">覆盖已有文件</span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="batchConflict"
                  checked={conflictAction() === "rename"}
                  onChange={() => setConflictAction("rename")}
                />
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
            <Button variant="ghost" onClick={() => dialogCtx.close()}>
              取消
            </Button>
            <Button onClick={handleStart} disabled={!pdfModel() || starting()}>
              {starting() ? "启动中..." : `开始转换（${fileInfos().filter((f) => f.pageCount <= 50).length} 个文件）`}
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
