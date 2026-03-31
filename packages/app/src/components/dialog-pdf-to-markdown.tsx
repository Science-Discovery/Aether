/**
 * PDF 转 Markdown 配置对话框
 *
 * 开始转换后关闭对话框，进度通过全局 signal 推送到顶部进度条。
 */

import { type Component, Show, createSignal, createMemo, createEffect, onMount } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useModels } from "@/context/models"
import { ModelSelectorPopover } from "./dialog-select-model"
import { OutputDirectory } from "./output-directory"
import { registerConvertTask, updateConvertTask, triggerOpenFile, triggerRefreshDir, registerEventSource, getCurrentPhase, taskUrl } from "./pdf-convert-progress"

// ===== PDF 转换设置持久化（localStorage） =====
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
    if (raw) return { outputMode: "merged", autoOpen: true, conflictAction: "replace", outputTarget: "neighbor", ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { outputMode: "merged", autoOpen: true, conflictAction: "replace", outputTarget: "neighbor" }
}

function saveSettings(s: Partial<PdfConvertSettings>) {
  try {
    const current = loadSettings()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...s }))
  } catch { /* ignore */ }
}

// ===== PDF 转换专用模型选择（全局持久化，与聊天模型完全独立） =====
type ModelKey = { providerID: string; modelID: string }
const _initSettings = loadSettings()
const [_pdfModelKey, _setPdfModelKey] = createSignal<ModelKey | undefined>(_initSettings.model)
let _pdfModelInitialized = !!_initSettings.model

/** 获取/设置 PDF 转换专用的模型 key（全局单例） */
function getPdfModelKey() { return _pdfModelKey() }
function setPdfModelKey(key: ModelKey | undefined) {
  _pdfModelInitialized = true
  _setPdfModelKey(key)
  saveSettings({ model: key })
}

export const DialogPdfToMarkdown: Component<{
  pdfPath: string
}> = (props) => {
  const dialogCtx = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  const server = useServer()
  const models = useModels()

  const [pageCount, setPageCount] = createSignal<number | null>(null)
  const [startPage, setStartPage] = createSignal(1)
  const [endPage, setEndPage] = createSignal(1)
  const [outputMode, setOutputMode] = createSignal<"merged" | "per-page">(loadSettings().outputMode)
  const [autoOpen, setAutoOpen] = createSignal(loadSettings().autoOpen)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [starting, setStarting] = createSignal(false)
  const [pythonAvailable, setPythonAvailable] = createSignal(true)
  const [pythonMissing, setPythonMissing] = createSignal<string[]>([])
  const [existingFiles, setExistingFiles] = createSignal<string[]>([])
  const [conflictAction, setConflictAction] = createSignal<"replace" | "rename">(loadSettings().conflictAction)
  const [outputTarget, setOutputTarget] = createSignal<"neighbor" | "custom">(loadSettings().outputTarget)
  const [outputDir, setOutputDir] = createSignal(loadSettings().outputDir ?? "")
  const [outputDirError, setOutputDirError] = createSignal<string | null>(null)
  // fetch 帮助函数
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

  const selectedOutputDir = createMemo(() => {
    if (outputTarget() !== "custom") return
    const value = outputDir().trim()
    if (!value) return
    return value
  })

  const loadPdfInfo = async () => {
    setLoading(true)
    try {
      const suffix = selectedOutputDir() ? `&outputDir=${encodeURIComponent(selectedOutputDir()!)}` : ""
      const pageRes = await fetchApi(`/file/pdf-page-count?path=${encodeURIComponent(props.pdfPath)}${suffix}`)
      if (!pageRes.ok) {
        const err = await pageRes.json()
        throw new Error(err.error || "获取页数失败")
      }
      const pageData = await pageRes.json()
      setPageCount(pageData.pageCount)
      setEndPage((prev) => {
        const next = Math.min(pageData.pageCount, 50)
        if (prev > pageData.pageCount) return next
        if (prev < 1) return 1
        return prev || next
      })
      if (outputTarget() === "custom" && !selectedOutputDir()) {
        setExistingFiles([])
      } else {
        setExistingFiles(pageData.existingFiles ?? [])
      }
      setError(null)
    } catch (e: any) {
      setExistingFiles([])
      if (e?.message === "路径必须指向一个文件夹") {
        setError(null)
      } else {
        setError(e?.message || "获取 PDF 页数失败")
      }
    } finally {
      setLoading(false)
    }
  }

  onMount(async () => {
    const pyRes = await fetchApi("/file/pdf-python-check").catch(() => null)
    if (pyRes?.ok) {
      const pyData = await pyRes.json()
      setPythonAvailable(pyData.available)
      setPythonMissing(pyData.missingDeps ?? [])
    }
  })

  createEffect(() => {
    outputTarget()
    selectedOutputDir()
    void loadPdfInfo()
  })

  const overLimit = createMemo(() => {
    const count = pageCount()
    return count !== null && count > 50
  })

  const rangeOverLimit = createMemo(() => {
    return endPage() - startPage() + 1 > 50
  })

  const conflicts = createMemo(() => {
    if (outputMode() === "merged") return existingFiles().filter((file) => /\.md$/i.test(file))
    return existingFiles().filter((file) => !/\.[^./\\]+$/i.test(file))
  })

  // PDF 转换模型：首次打开时用聊天模型初始化，之后完全独立
  if (!_pdfModelInitialized) {
    const m = local.model.current()
    if (m) _setPdfModelKey({ providerID: m.provider.id, modelID: m.id })
    _pdfModelInitialized = true
  }
  const pdfModel = createMemo(() => {
    const key = getPdfModelKey()
    if (!key) return undefined
    return models.find(key)
  })
  // 适配 ModelSelectorPopover 的 model prop 接口
  const pdfModelState = {
    ready: models.ready,
    current: pdfModel,
    recent: () => models.recent.list().map(models.find).filter(Boolean),
    list: models.list,
    cycle: () => {},
    set: (item: ModelKey | undefined, _options?: { recent?: boolean }) => {
      setPdfModelKey(item ? { providerID: item.providerID, modelID: item.modelID } : undefined)
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

  const connectSSE = (taskID: string) => {
    const baseUrl = sdk.url
    const url = taskUrl(baseUrl, "/file/pdf-to-markdown/progress", taskID, sdk.directory, server.current?.http)
    const es = new EventSource(url)
    registerEventSource(es)

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        switch (data.type) {
          case "progress":
            updateConvertTask({
              currentPage: data.currentPage,
              totalPages: data.totalPages,
              phase: data.phase,
            })
            break
          case "token":
            updateConvertTask({ tokenInput: data.input, tokenOutput: data.output })
            break
          case "page_done":
            updateConvertTask({ streamContent: "" })
            break
          case "stream":
            // 暂不在小条里显示流内容
            break
          case "done":
            // 如果正处于 postqa 阶段，延迟一下让用户看到"正在检查"
            {
              const finish = () => {
                updateConvertTask({ status: "done", outputPath: data.outputPath })
                es.close()
                if (data.outputPath) {
                  triggerRefreshDir(data.outputPath)
                  triggerOpenFile(data.outputPath)
                }
              }
              if (getCurrentPhase() === "postqa") {
                setTimeout(finish, 1200)
              } else {
                finish()
              }
            }
            break
          case "error":
            if (!data.page) {
              updateConvertTask({ status: "error", error: data.message })
              es.close()
            }
            break
        }
      } catch { /* ignore */ }
    }

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) es.close()
    }
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
    // 保存当前选项供下次使用
    saveSettings({
      outputMode: outputMode(),
      autoOpen: autoOpen(),
      conflictAction: conflictAction(),
      outputTarget: outputTarget(),
      outputDir: outputDir().trim() || undefined,
    })
    try {
      const res = await fetchApi("/file/pdf-to-markdown", {
        method: "POST",
        body: JSON.stringify({
          path: props.pdfPath,
          providerID: model.provider.id,
          modelID: model.id,
          startPage: startPage(),
          endPage: endPage(),
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
        throw new Error(err.error || "启动转换失败")
      }
      const { taskID } = await res.json()

      // 注册到全局进度条
      registerConvertTask(
        {
          taskID,
          pdfPath: props.pdfPath,
          status: "running",
          currentPage: 0,
          totalPages: endPage() - startPage() + 1,
          phase: "text",
        },
        fetchApi,
        autoOpen(),
      )

      connectSSE(taskID)

      // 关闭对话框
      dialogCtx.close()
    } catch (e: any) {
      showToast({ variant: "error", title: "启动失败", description: e?.message })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog title="PDF 转 Markdown" size="large" persistent>
      <div class="flex flex-col gap-4 p-4 max-h-[70vh] overflow-y-auto">
        <Show when={loading()}>
          <div class="text-text-weak text-sm">正在获取 PDF 信息...</div>
        </Show>

        <Show when={error()}>
          <div class="text-red-500 text-sm">{error()}</div>
        </Show>

        <Show when={overLimit()}>
          <div class="p-3 rounded-md bg-red-500/10 border border-red-500/20">
            <p class="text-red-500 text-sm font-medium">
              该 PDF 共 {pageCount()} 页，超过了 50 页的上限，无法转换。
            </p>
          </div>
          <div class="flex justify-end pt-2">
            <Button variant="ghost" onClick={() => dialogCtx.close()}>关闭</Button>
          </div>
        </Show>

        <Show when={!loading() && !error() && !overLimit() && !pythonAvailable() && pageCount() !== null}>
          <div class="p-3 rounded-md bg-red-500/10 border border-red-500/20">
            <p class="text-red-500 text-sm font-medium">Python 环境不可用，无法进行 PDF 转换。</p>
            <p class="text-red-400 text-xs mt-1">
              缺少依赖：{pythonMissing().join("、") || "Python3、PyMuPDF、Pillow"}
            </p>
            <p class="text-text-weak text-xs mt-1">
              请安装：<code class="bg-surface-raised px-1 rounded">pip install PyMuPDF Pillow</code>
            </p>
          </div>
          <div class="flex justify-end pt-2">
            <Button variant="ghost" onClick={() => dialogCtx.close()}>关闭</Button>
          </div>
        </Show>

        <Show when={!loading() && !error() && !overLimit() && pythonAvailable() && pageCount() !== null}>
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
                注意：PDF 转 Markdown 会对每一页调用多次多模态 LLM，可能产生较大的 API 费用开销
              </p>
            </div>
          </div>

          {/* 页面范围 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">页面范围</label>
            <div class="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={pageCount() ?? 1}
                value={startPage()}
                onInput={(e) => setStartPage(Math.max(1, parseInt(e.currentTarget.value) || 1))}
                class="w-20 px-2 py-1 rounded border border-border-base bg-surface-base text-text-base text-sm"
              />
              <span class="text-text-weak text-sm">至</span>
              <input
                type="number"
                min={1}
                max={pageCount() ?? 1}
                value={endPage()}
                onInput={(e) => setEndPage(Math.max(1, parseInt(e.currentTarget.value) || 1))}
                class="w-20 px-2 py-1 rounded border border-border-base bg-surface-base text-text-base text-sm"
              />
              <span class="text-text-weak text-sm">/ 共 {pageCount()} 页</span>
            </div>
            <p class="text-xs text-text-weak">此处为 PDF 文件页码（从第 1 页到最后一页），非书本印刷页码</p>
            <Show when={rangeOverLimit()}>
              <p class="text-xs text-red-500">页面范围不能超过 50 页</p>
            </Show>
          </div>

          {/* 输出模式 */}
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium text-text-base">输出模式</label>
            <div class="flex flex-col gap-1">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="outputMode" checked={outputMode() === "merged"} onChange={() => setOutputMode("merged")} />
                <span class="text-text-base">合并为一个 Markdown 文件</span>
              </label>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="outputMode" checked={outputMode() === "per-page"} onChange={() => setOutputMode("per-page")} />
                <span class="text-text-base">每页一个 Markdown 文件</span>
              </label>
            </div>
          </div>

          <OutputDirectory
            label="输出位置"
            title="选择 PDF 转换输出文件夹"
            name="pdfOutputTarget"
            neighbor="保存在原 PDF 文件旁边"
            custom="保存在指定文件夹"
            target={outputTarget}
            setTarget={setOutputTarget}
            value={outputDir}
            setValue={setOutputDir}
            error={outputDirError}
            setError={setOutputDirError}
          />

          {/* 转换完成后自动打开 */}
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={autoOpen()} onChange={(e) => setAutoOpen(e.currentTarget.checked)} />
            <span class="text-text-base">转换完成后自动打开生成的文件</span>
          </label>

          {/* 文件冲突提示 */}
          <Show when={conflicts().length > 0}>
            <div class="p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <p class="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                检测到已存在的转换文件：
              </p>
              <ul class="text-xs text-text-weak mt-1 list-disc pl-4">
                {conflicts().map((f) => <li>{f.split("/").pop()}</li>)}
              </ul>
              <div class="flex flex-col gap-1 mt-2">
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="conflict" checked={conflictAction() === "replace"} onChange={() => setConflictAction("replace")} />
                  <span class="text-text-base">覆盖已有文件</span>
                </label>
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="conflict" checked={conflictAction() === "rename"} onChange={() => setConflictAction("rename")} />
                  <span class="text-text-base">重命名新文件（如 xxx(1).md）</span>
                </label>
              </div>
            </div>
          </Show>

          {/* 操作按钮 */}
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => dialogCtx.close()}>取消</Button>
            <Button onClick={handleStart} disabled={!pdfModel() || starting() || rangeOverLimit()}>
              {starting() ? "启动中..." : "开始"}
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
