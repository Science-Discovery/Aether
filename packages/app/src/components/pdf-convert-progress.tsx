/**
 * PDF 转换进度条 — 全局单例，固定在顶部栏"复制路径"左边
 *
 * 用全局 signal 管理状态，对话框写入，进度条读取。
 * 对话框关闭后进度条依然存在。
 */

import { type Component, Show, createSignal, createEffect, on } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

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
  /** 批量任务：当前文件索引（从 1 开始） */
  batchIndex: number
  /** 批量任务：总文件数 */
  batchTotal: number
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
  batchIndex: 0,
  batchTotal: 0,
}

const [globalTask, setGlobalTask] = createStore<PdfConvertTask>({ ...emptyTask })
const [globalVisible, setGlobalVisible] = createSignal(false)
/** 自动隐藏定时器，注册新任务时取消 */
let autoHideTimer: ReturnType<typeof setTimeout> | null = null

// fetchApi 函数引用，由对话框注入
let globalFetchApi: ((url: string, opts?: RequestInit) => Promise<Response>) | null = null
let globalAutoOpen = true
/** SSE 连接引用，用于取消时立即关闭 */
let globalEventSource: EventSource | null = null
/** 外部注册的打开文件回调（由持有 file/tab context 的组件提供） */
let globalOpenFileCallback: ((filePath: string) => void) | null = null
/** 外部注册的刷新目录回调（转换完成后刷新文件树） */
let globalRefreshDirCallback: ((dirPath: string) => void) | null = null

type Http = {
  username?: string
  password?: string
}

/** 注册打开文件的回调（由 file-tabs.tsx 等组件调用） */
export function registerOpenFileCallback(cb: (filePath: string) => void) {
  globalOpenFileCallback = cb
}

/** 注册刷新目录的回调 */
export function registerRefreshDirCallback(cb: (dirPath: string) => void) {
  globalRefreshDirCallback = cb
}

/** 触发刷新输出文件所在目录（使新文件出现在文件树中） */
export function triggerRefreshDir(filePath: string) {
  if (!globalRefreshDirCallback) return
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ""
  globalRefreshDirCallback(dir)
}

/** 注册 SSE EventSource 引用 */
export function registerEventSource(es: EventSource) {
  globalEventSource = es
}

export function taskUrl(
  baseUrl: string,
  path: string,
  taskID: string,
  directory: string,
  http?: Http,
) {
  const auth = http?.password ? `&_auth=${btoa(`${http.username ?? "opencode"}:${http.password}`)}` : ""
  return `${baseUrl}${path}?taskID=${taskID}&directory=${encodeURIComponent(directory)}${auth}`
}

/** 对话框调用：注册一个新的转换任务到全局状态 */
export function registerConvertTask(
  task: Partial<PdfConvertTask>,
  fetchApi: (url: string, opts?: RequestInit) => Promise<Response>,
  autoOpen: boolean,
) {
  // 取消之前的自动隐藏定时器，防止新任务刚注册就被隐藏
  if (autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }
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
      case "translate": return "翻译文本"
      case "reconnecting": return "重新连接"
      default: return task.phase
    }
  }

  const fmt = (n: number) => `${(n / 1000).toFixed(1)}k`

  const isTranslate = () => task.taskType === "translate"
  const unitLabel = () => isTranslate() ? "块" : "页"
  const isBatch = () => task.batchTotal > 1
  const batchPrefix = () => isBatch() ? `[${task.batchIndex}/${task.batchTotal}] ` : ""

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

  // 完成时自动隐藏（批量任务最后一个完成后才隐藏）
  createEffect(on(() => task.status, (status) => {
    if (status === "done" || status === "error" || status === "cancelled") {
      // 清除之前的定时器
      if (autoHideTimer) clearTimeout(autoHideTimer)
      autoHideTimer = setTimeout(() => {
        if (task.status !== "running") setGlobalVisible(false)
        autoHideTimer = null
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
          class="flex-1 min-w-0 text-text-weak truncate cursor-pointer"
          onClick={() => setExpanded(!expanded())}
        >
          <Show when={isRunning() && isQueued()}>
            {batchPrefix()}{isTranslate() ? "翻译" : "PDF"} 排队中（第 {queuePosition()} 位）
          </Show>
          <Show when={isRunning() && !isQueued()}>
            <Show when={task.phase === "postqa"} fallback={
              <>{batchPrefix()}{isTranslate() ? "翻译" : "PDF"} {task.currentPage}/{task.totalPages}{unitLabel()}·{phaseLabel()}</>
            }>
              {batchPrefix()}正在检查
            </Show>
          </Show>
          <Show when={isDone()}>
            <Show when={isBatch()} fallback={isTranslate() ? "翻译完成" : "PDF 转换完成"}>
              {task.batchIndex < task.batchTotal
                ? <>{batchPrefix()}{isTranslate() ? "翻译完成" : "转换完成"}，准备下一个...</>
                : <>全部完成（{task.batchTotal} 个文件）</>
              }
            </Show>
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

/**
 * 页面加载时查询后端活跃任务，恢复进度条和 SSE 连接。
 * 由会话级组件在挂载时调用。
 */
export async function restoreActiveTasks(
  fetchApi: (url: string, opts?: RequestInit) => Promise<Response>,
  baseUrl: string,
  directory: string,
  http?: Http,
) {
  try {
    const res = await fetchApi("/file/active-tasks")
    if (!res.ok) return
    const tasks = await res.json() as { taskID: string; status: string; path: string; taskType: "convert" | "translate" }[]
    if (tasks.length === 0) return

    // 取第一个运行中的任务恢复进度条
    const activeTask = tasks[0]
    const isTranslate = activeTask.taskType === "translate"
    const cancelUrl = isTranslate ? "/file/translate-markdown/cancel" : "/file/pdf-to-markdown/cancel"
    const path = isTranslate ? "/file/translate-markdown/progress" : "/file/pdf-to-markdown/progress"

    registerConvertTask(
      {
        taskID: activeTask.taskID,
        pdfPath: activeTask.path,
        status: "running",
        currentPage: 0,
        totalPages: 0,
        phase: "reconnecting",
        taskType: isTranslate ? "translate" : "pdf-convert",
        cancelUrl,
        batchIndex: 1,
        batchTotal: tasks.length,
      },
      fetchApi,
      false,
    )

    // 连接 SSE 恢复实时进度
    const url = taskUrl(baseUrl, path, activeTask.taskID, directory, http)
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
          case "done":
            updateConvertTask({ status: "done", outputPath: data.outputPath })
            if (data.outputPath) triggerRefreshDir(data.outputPath)
            es.close()
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
      if (es.readyState === EventSource.CLOSED) {
        es.close()
      }
    }
  } catch {
    // 查询失败，静默忽略
  }
}

// 兼容旧导入
export const PdfConvertProgress = PdfConvertProgressBar
