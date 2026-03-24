/**
 * PDF 转换任务状态管理 Context
 */

import { createContext, useContext, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "./sdk"
import { useServer } from "./server"

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
}

interface PdfConvertState {
  tasks: Record<string, PdfConvertTask>
  pythonAvailable: boolean | null
  pythonChecked: boolean
}

interface PdfConvertActions {
  fetchApi: (path: string, options?: RequestInit) => Promise<Response>
  checkPython: () => Promise<{ available: boolean; missingDeps: string[] }>
  getPageCount: (pdfPath: string) => Promise<{ pageCount: number; outputPath: { merged: string; perPage: string; images: string } }>
  startConversion: (config: {
    path: string
    providerID: string
    modelID: string
    startPage: number
    endPage: number
    outputMode: "merged" | "per-page"
    conflictAction: "replace" | "rename" | "cancel"
  }) => Promise<string>
  cancelConversion: (taskID: string) => Promise<void>
  connectSSE: (taskID: string) => void
  getTask: (pdfPath: string) => PdfConvertTask | undefined
}

type PdfConvertContextValue = PdfConvertState & PdfConvertActions

const PdfConvertContext = createContext<PdfConvertContextValue>()

export function usePdfConvert(): PdfConvertContextValue {
  const ctx = useContext(PdfConvertContext)
  if (!ctx) throw new Error("usePdfConvert must be used within PdfConvertProvider")
  return ctx
}

export const PdfConvertProvider: Component<{ children: JSX.Element }> = (props) => {
  const sdk = useSDK()
  const server = useServer()

  const [state, setState] = createStore<PdfConvertState>({
    tasks: {},
    pythonAvailable: null,
    pythonChecked: false,
  })

  const fetchApi = async (path: string, options: RequestInit = {}): Promise<Response> => {
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

    return fetch(`${baseUrl}${path}?directory=${encodeURIComponent(sdk.directory)}`, {
      ...options,
      headers,
    })
  }

  const checkPython = async () => {
    const res = await fetchApi("/file/pdf-python-check")
    const data = await res.json()
    setState("pythonAvailable", data.available)
    setState("pythonChecked", true)
    return data
  }

  const getPageCount = async (pdfPath: string) => {
    const res = await fetchApi(`/file/pdf-page-count?path=${encodeURIComponent(pdfPath)}`)
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || "获取页数失败")
    }
    return res.json()
  }

  const startConversion = async (config: Parameters<PdfConvertActions["startConversion"]>[0]) => {
    const res = await fetchApi("/file/pdf-to-markdown", {
      method: "POST",
      body: JSON.stringify(config),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || "启动转换失败")
    }
    const { taskID } = await res.json()

    // 创建任务状态
    setState("tasks", taskID, {
      taskID,
      pdfPath: config.path,
      status: "running",
      currentPage: 0,
      totalPages: config.endPage - config.startPage + 1,
      phase: "text",
      tokenInput: 0,
      tokenOutput: 0,
      streamContent: "",
      outputPath: null,
      error: null,
    })

    // 自动连接 SSE
    connectSSE(taskID)
    return taskID
  }

  const cancelConversion = async (taskID: string) => {
    await fetchApi("/file/pdf-to-markdown/cancel", {
      method: "POST",
      body: JSON.stringify({ taskID }),
    })
    setState("tasks", taskID, "status", "cancelled")
  }

  const connectSSE = (taskID: string) => {
    const baseUrl = sdk.url
    const s = server.current?.http
    const authParam = s?.password
      ? `&_auth=${btoa(`${s.username ?? "opencode"}:${s.password}`)}`
      : ""

    const url = `${baseUrl}/file/pdf-to-markdown/progress?taskID=${taskID}&directory=${encodeURIComponent(sdk.directory)}${authParam}`

    const eventSource = new EventSource(url)

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        const task = state.tasks[taskID]
        if (!task) return

        switch (data.type) {
          case "progress":
            setState("tasks", taskID, {
              currentPage: data.currentPage,
              totalPages: data.totalPages,
              phase: data.phase,
            })
            break
          case "stream":
            setState("tasks", taskID, "streamContent", (prev: string) => {
              const next = prev + data.content
              // 只保留最后 2000 字符
              return next.length > 2000 ? next.slice(-2000) : next
            })
            break
          case "token":
            setState("tasks", taskID, {
              tokenInput: data.input,
              tokenOutput: data.output,
            })
            break
          case "page_done":
            // 清空流式内容
            setState("tasks", taskID, "streamContent", "")
            break
          case "done":
            setState("tasks", taskID, {
              status: "done",
              outputPath: data.outputPath,
            })
            eventSource.close()
            break
          case "error":
            if (data.page) {
              // 单页错误，不终止
            } else {
              setState("tasks", taskID, {
                status: "error",
                error: data.message,
              })
              eventSource.close()
            }
            break
        }
      } catch {
        // 忽略解析错误
      }
    }

    eventSource.onerror = () => {
      eventSource.close()
    }
  }

  const getTask = (pdfPath: string) => {
    return Object.values(state.tasks).find((t) => t.pdfPath === pdfPath && t.status === "running")
  }

  const value: PdfConvertContextValue = {
    get tasks() { return state.tasks },
    get pythonAvailable() { return state.pythonAvailable },
    get pythonChecked() { return state.pythonChecked },
    fetchApi,
    checkPython,
    getPageCount,
    startConversion,
    cancelConversion,
    connectSSE,
    getTask,
  }

  return (
    <PdfConvertContext.Provider value={value}>
      {props.children}
    </PdfConvertContext.Provider>
  )
}
