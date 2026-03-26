/**
 * Markdown 翻译配置对话框
 *
 * 模式参考 dialog-pdf-to-markdown.tsx，但更简单（无页面范围、输出模式、Python 检查）。
 */

import { type Component, Show, createSignal, createMemo, onMount } from "solid-js"
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

// ===== 翻译设置持久化（localStorage） =====
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

// ===== 翻译专用模型选择（全局持久化，与 PDF/聊天模型独立） =====
type ModelKey = { providerID: string; modelID: string }
const _initSettings = loadSettings()
const [_translateModelKey, _setTranslateModelKey] = createSignal<ModelKey | undefined>(_initSettings.model)
let _translateModelInitialized = !!_initSettings.model

function getTranslateModelKey() { return _translateModelKey() }
function setTranslateModelKey(key: ModelKey | undefined) {
  _translateModelInitialized = true
  _setTranslateModelKey(key)
  saveSettings({ model: key })
}

export const DialogTranslateMarkdown: Component<{
  mdPath: string
}> = (props) => {
  const dialogCtx = useDialog()
  const local = useLocal()
  const sdk = useSDK()
  const server = useServer()
  const models = useModels()

  const [chunkCount, setChunkCount] = createSignal<number | null>(null)
  const [hasDataJson, setHasDataJson] = createSignal(false)
  const [autoOpen, setAutoOpen] = createSignal(loadSettings().autoOpen)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [starting, setStarting] = createSignal(false)
  const [existingFiles, setExistingFiles] = createSignal<string[]>([])
  const [conflictAction, setConflictAction] = createSignal<"replace" | "rename">(loadSettings().conflictAction)

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
      const res = await fetchApi(`/file/translate-markdown/check?path=${encodeURIComponent(props.mdPath)}`)
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "预检查失败")
      }
      const data = await res.json()
      setChunkCount(data.chunkCount)
      setHasDataJson(data.hasDataJson)
      if (data.existingFiles?.length > 0) {
        setExistingFiles(data.existingFiles)
      }
    } catch (e: any) {
      setError(e?.message || "预检查失败")
    } finally {
      setLoading(false)
    }
  })

  // 翻译模型：首次打开时用聊天模型初始化，之后完全独立
  if (!_translateModelInitialized) {
    const m = local.model.current()
    if (m) _setTranslateModelKey({ providerID: m.provider.id, modelID: m.id })
    _translateModelInitialized = true
  }
  const translateModel = createMemo(() => {
    const key = getTranslateModelKey()
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
      setTranslateModelKey(item ? { providerID: item.providerID, modelID: item.modelID } : undefined)
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
    const url = `${baseUrl}/file/translate-markdown/progress?taskID=${taskID}&directory=${encodeURIComponent(sdk.directory)}`
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
          case "done":
            updateConvertTask({ status: "done", outputPath: data.outputPath })
            es.close()
            if (data.outputPath) {
              triggerOpenFile(data.outputPath)
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

    es.onerror = () => es.close()
  }

  const handleStart = async () => {
    const model = translateModel()
    if (!model) {
      showToast({ variant: "error", title: "请先选择模型" })
      return
    }

    setStarting(true)
    saveSettings({
      autoOpen: autoOpen(),
      conflictAction: conflictAction(),
    })
    try {
      const res = await fetchApi("/file/translate-markdown", {
        method: "POST",
        body: JSON.stringify({
          path: props.mdPath,
          providerID: model.provider.id,
          modelID: model.id,
          targetLanguage: "zh-CN",
          conflictAction: conflictAction(),
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "启动翻译失败")
      }
      const { taskID } = await res.json()

      registerConvertTask(
        {
          taskID,
          pdfPath: props.mdPath,
          status: "running",
          currentPage: 0,
          totalPages: chunkCount() ?? 0,
          phase: "translate",
          taskType: "translate",
          cancelUrl: "/file/translate-markdown/cancel",
        },
        fetchApi,
        autoOpen(),
      )

      connectSSE(taskID)
      dialogCtx.close()
    } catch (e: any) {
      showToast({ variant: "error", title: "启动失败", description: e?.message })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog title="翻译为中文" size="large">
      <div class="flex flex-col gap-4 p-4 max-h-[70vh] overflow-y-auto">
        <Show when={loading()}>
          <div class="text-text-weak text-sm">正在检查文件信息...</div>
        </Show>

        <Show when={error()}>
          <div class="text-red-500 text-sm">{error()}</div>
        </Show>

        <Show when={!loading() && !error() && chunkCount() !== null}>
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
                翻译会对每一块调用 LLM，较长文件会产生一定 API 费用
              </p>
            </div>
          </div>

          {/* _data.json 检测提示 */}
          <Show when={hasDataJson()}>
            <div class="p-2 rounded-md bg-blue-500/10 border border-blue-500/20">
              <p class="text-xs text-blue-600 dark:text-blue-400">
                检测到该文件由 PDF 转换生成，将使用逐页翻译模式（共 {chunkCount()} 页）以获得更好效果
              </p>
            </div>
          </Show>

          <Show when={!hasDataJson()}>
            <p class="text-xs text-text-weak">
              文件将被分为 {chunkCount()} 个块进行翻译
            </p>
          </Show>

          {/* 自动打开复选框 */}
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={autoOpen()} onChange={(e) => setAutoOpen(e.currentTarget.checked)} />
            <span class="text-text-base">翻译完成后自动打开生成的文件</span>
          </label>

          {/* 文件冲突提示 */}
          <Show when={existingFiles().length > 0}>
            <div class="p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20">
              <p class="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                检测到已存在的翻译文件：
              </p>
              <ul class="text-xs text-text-weak mt-1 list-disc pl-4">
                {existingFiles().map((f) => <li>{f.split("/").pop()}</li>)}
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
            <Button onClick={handleStart} disabled={!translateModel() || starting()}>
              {starting() ? "启动中..." : "开始"}
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
