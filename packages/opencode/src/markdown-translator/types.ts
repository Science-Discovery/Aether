/**
 * Markdown 翻译功能的类型定义
 */

/** 翻译任务配置 */
export interface TranslateConfig {
  path: string
  providerID: string
  modelID: string
  targetLanguage: string
  conflictAction: "replace" | "rename" | "cancel"
  outputDir?: string
}

/** SSE 进度事件类型 */
export type TranslateProgressEvent =
  | { type: "progress"; currentPage: number; totalPages: number; phase: "translate" }
  | { type: "token"; input: number; output: number; total: number }
  | { type: "page_done"; page: number; figureCount: number }
  | { type: "done"; outputPath: string; totalTokens: { input: number; output: number } }
  | { type: "error"; message: string; page?: number }

/** 翻译任务状态 */
export interface TranslateTask {
  id: string
  config: TranslateConfig
  status: "running" | "done" | "error" | "cancelled"
  events: TranslateProgressEvent[]
  listeners: Set<(event: TranslateProgressEvent) => void>
  abortController: AbortController
}
