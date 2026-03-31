/**
 * PDF → Markdown 转换功能的类型定义
 */

/** PDF 页面渲染结果（Python render_page.py 输出） */
export interface PageRenderResult {
  image_path: string
  width: number
  height: number
  actual_dpi: number
  embedded_text: string
  embedded_image_count: number
  /** 页面是否包含矢量图形（费曼图、示意图等 PDF path 绘图） */
  has_vector_figures: boolean
}

/** 图片裁剪结果（Python crop_image.py 输出） */
export interface CropResult {
  output_path: string
  width: number
  height: number
}

/** LLM 文字提取结果 */
export interface TextExtractionResult {
  content: string
  figure_count: number
}

/** LLM 图片 bbox 提取结果 */
export interface FigureInfo {
  figure_id: string
  figure_label: string
  caption: string
  caption_top_y: number | null
  caption_bottom_y: number | null
  bbox: [number, number, number, number]
  description: string
}

export interface FigureExtractionResult {
  figures: FigureInfo[]
}

/** 公式图片信息 */
export interface FormulaFigureInfo {
  ffig_id: string
  bbox: [number, number, number, number]
  description: string
}

export interface FormulaFigureExtractionResult {
  formula_figures: FormulaFigureInfo[]
}

/** 针对性修复结果 */
export interface TextFixResult {
  fixed_content: string
  fixes_applied: string[]
}

/** 单页处理结果 */
export interface PageResult {
  page_num: number
  has_text_layer: boolean
  figures: FigureInfo[]
  formula_figures: FormulaFigureInfo[]
  raw_content: string
  final_content: string
  issues_detected: string[]
  fixes_applied: string[]
  tokens: { input: number; output: number }
}

/** SSE 进度事件类型 */
export type ProgressEvent =
  | { type: "progress"; currentPage: number; totalPages: number; phase: "text" | "figure" | "fix" | "crop" | "postqa" | `queued:${number}` }
  | { type: "stream"; content: string }
  | { type: "token"; input: number; output: number; total: number }
  | { type: "page_done"; page: number; figureCount: number }
  | { type: "done"; outputPath: string; totalTokens: { input: number; output: number } }
  | { type: "error"; message: string; page?: number }

/** 转换任务配置 */
export interface ConvertConfig {
  path: string
  providerID: string
  modelID: string
  startPage: number
  endPage: number
  outputMode: "merged" | "per-page"
  conflictAction: "replace" | "rename" | "cancel"
  dpi?: number
}

/** 转换任务状态 */
export interface ConvertTask {
  id: string
  config: ConvertConfig
  status: "running" | "done" | "error" | "cancelled"
  events: ProgressEvent[]
  /** 新事件通知回调列表（供 SSE 端点订阅） */
  listeners: Set<(event: ProgressEvent) => void>
  abortController: AbortController
}

/** 结构化中间数据 JSON */
export interface ConvertDataJSON {
  version: string
  source_pdf: string
  source_language: string
  model: { provider: string; model: string }
  pages: PageResult[]
  output_mode: "merged" | "per-page"
  total_tokens: { input: number; output: number }
  post_qa_results?: Record<string, unknown>
}

/** 输出路径信息 */
export interface OutputPaths {
  merged: string
  perPage: string
  images: string
}
