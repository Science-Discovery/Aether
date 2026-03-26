/**
 * PDF 转换进度条 — 全局单例，固定在顶部栏"复制路径"左边
 *
 * 用全局 signal 管理状态，对话框写入，进度条读取。
 * 对话框关闭后进度条依然存在。
 */

import { type Component, Show, createSignal, createEffect, on } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"

export interface PdfConvertTask {
  taskID: string
  pdfPath: string
  status: "running" | "done" | "error" | "cancelled"
  currentPage: number
  totalPages: number
  phase: string
  tokenInput: number
  tokenOutput: number
  streamContent: string
  outputPath: string | null
  error: string | null
  taskType: "pdf-convert" | "translate"
  cancelUrl: string
}

// ===== 全局状态 =====

const emptyTask: PdfConvertTask = {
  taskID: "",
  pdfPath: "",
  status: "done",
  currentPage: 0,
  totalPages: 0,
  phase: "",
  tokenInput: 0,
  tokenOutput: 0,
  streamContent: "",
  outputPath: null,
  error: null,
  taskType: "pdf-convert",
  cancelUrl: "/file/pdf-to-markdown/cancel",
}

const [globalTask, setGlobalTask] = createStore<PdfConvertTask>({ ...emptyTask })
const [globalVisible, setGlobalVisible] = createSignal(false)

// fetchApi 函数引用，由对话框注入
let globalFetchApi: ((url: string, opts?: RequestInit) => Promise<Response>) | null = null
let globalAutoOpen = true
/** SSE 连接引用，用于取消时立即关闭 */
let globalEventSource: EventSource | null = null
/** 外部注册的打开文件回调（由持有 file/tab context 的组件提供） */
let globalOpenFileCallback: ((filePath: string) => void) | null = null

/** 注册打开文件的回调（由 file-tabs.tsx 等组件调用） */
export function registerOpenFileCallback(cb: (filePath: string) => void) {
  globalOpenFileCallback = cb
}

/** 注册 SSE EventSource 引用 */
export function registerEventSource(es: EventSource) {
  globalEventSource = es
}

/** 对话框调用：注册一个新的转换任务到全局状态 */
export function registerConvertTask(
  task: Partial<PdfConvertTask>,
  fetchApi: (url: string, opts?: RequestInit) => Promise<Response>,
  autoOpen: boolean,
) {
  globalFetchApi = fetchApi
  globalAutoOpen = autoOpen
  setGlobalTask(reconcile({ ...emptyTask, ...task }))
  setGlobalVisible(true)
}

/** 对话框调用：更新全局任务状态 */
export function updateConvertTask(patch: Partial<PdfConvertTask>) {
  setGlobalTask(patch)
}

/** 获取当前任务的 phase */
export function getCurrentPhase(): string {
  return globalTask.phase
}

/** 关闭进度条 */
export function dismissConvertProgress() {
  setGlobalVisible(false)
}

/** 触发打开文件（转换完成后调用） */
export function triggerOpenFile(filePath: string) {
  if (globalAutoOpen && globalOpenFileCallback) {
    globalOpenFileCallback(filePath)
  }
}

// ===== 进度条组件 =====

export const PdfConvertProgressBar: Component = () => {
  const [expanded, setExpanded] = createSignal(false)

  const task = globalTask
  const visible = globalVisible

  const percentage = () => {
    if (task.totalPages === 0) return 0
    return Math.round((task.currentPage / task.totalPages) * 100)
  }

  const isQueued = () => task.phase.startsWith("queued:")
  const queuePosition = () => {
    const match = task.phase.match(/^queued:(\d+)$/)
    return match ? parseInt(match[1]) : 0
  }

  const phaseLabel = () => {
    if (isQueued()) return `排队中（第 ${queuePosition()} 位）`
    switch (task.phase) {
      case "text": return "提取文字"
      case "figure": return "提取图片"
      case "fix": return "验证修复"
      case "crop": return "裁剪图片"
      case "postqa": return "质量检查"
      case "translate": return "翻译中"
      default: return task.phase
    }
  }

  const fmt = (n: number) => n.toLocaleString()

  const isTranslate = () => task.taskType === "translate"
  const unitLabel = () => isTranslate() ? "块" : "页"

  const isDone = () => task.status === "done" && task.taskID !== ""
  const isError = () => task.status === "error"
  const isCancelled = () => task.status === "cancelled"
  const isRunning = () => task.status === "running"

  const handleCancel = async () => {
    if (!task.taskID || !globalFetchApi) return
    // 立即关闭 SSE 连接
    if (globalEventSource) {
      globalEventSource.close()
      globalEventSource = null
    }
    try {
      await globalFetchApi(task.cancelUrl, {
        method: "POST",
        body: JSON.stringify({ taskID: task.taskID }),
      })
    } catch { /* ignore */ }
    setGlobalTask("status", "cancelled")
  }

  // 完成时 5 秒后自动隐藏
  createEffect(on(() => task.status, (status) => {
    if (status === "done" || status === "error" || status === "cancelled") {
      setTimeout(() => {
        if (task.status !== "running") setGlobalVisible(false)
      }, 8000)
    }
  }))

  return (
    <Show when={visible()}>
      <div class="flex items-center gap-2 px-2 py-1 rounded-md border border-border-base bg-surface-base text-xs select-none shrink-0 max-w-[360px]">
        {/* 状态指示点 */}
        <div
          class={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isRunning() ? "bg-brand animate-pulse" :
            isDone() ? "bg-green-500" :
            isError() ? "bg-red-500" :
            "bg-yellow-500"
          }`}
        />

        {/* 主文字 */}
        <span
          class="text-text-weak truncate cursor-pointer"
          onClick={() => setExpanded(!expanded())}
        >
          <Show when={isRunning() && isQueued()}>
            {isTranslate() ? "翻译" : "PDF"} 排队中（第 {queuePosition()} 位）
          </Show>
          <Show when={isRunning() && !isQueued()}>
            <Show when={task.phase === "postqa"} fallback={
              <>{isTranslate() ? "翻译" : "PDF"} {task.currentPage}/{task.totalPages} {unitLabel()} · {phaseLabel()}</>
            }>
              正在检查
            </Show>
          </Show>
          <Show when={isDone()}>
            {isTranslate() ? "翻译完成" : "PDF 转换完成"}
          </Show>
          <Show when={isError()}>
            转换失败
          </Show>
          <Show when={isCancelled()}>
            已取消
          </Show>
        </span>

        {/* Token 统计（始终显示） */}
        <Show when={isRunning() && (task.tokenInput > 0 || task.tokenOutput > 0)}>
          <span class="text-text-weak shrink-0">
            入{fmt(task.tokenInput)} 出{fmt(task.tokenOutput)}
          </span>
        </Show>

        {/* 百分比 */}
        <Show when={isRunning() && !isQueued()}>
          <span class="text-text-weak shrink-0">{percentage()}%</span>
        </Show>

        {/* 取消 */}
        <Show when={isRunning()}>
          <button
            class="text-text-weak hover:text-red-500 shrink-0"
            onClick={handleCancel}
            title="取消转换"
          >
            ✕
          </button>
        </Show>

        {/* 关闭（完成/失败后） */}
        <Show when={!isRunning()}>
          <button
            class="text-text-weak hover:text-text-base shrink-0"
            onClick={() => setGlobalVisible(false)}
            title="关闭"
          >
            ✕
          </button>
        </Show>
      </div>
    </Show>
  )
}

// 兼容旧导入
export const PdfConvertProgress = PdfConvertProgressBar
