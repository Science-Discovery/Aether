export namespace ReadingMode {
  export interface Settings {
    translatePrompt: string
    questionPrompt: string
    firstReadPrompt: string
    contextPageRange: 0 | 1 | 2
    autoFirstRead: boolean
  }

  export interface SessionMeta {
    pdfFileName: string
    pdfStorePath: string // absolute path under Global.Path.data/reading-mode/<sessionID>/
    lastReadPage: number
    annotationsPath: string // absolute path
    settings: Settings
    firstReadCompleted: boolean
  }

  export interface Annotation {
    id: string
    type: "highlight"
    page: number
    color: "yellow" | "red" | "green" | "blue"
    rects: Array<{ x1: number; y1: number; x2: number; y2: number }>
    selectedText: string
    note: string
    createdAt: number
  }

  export interface Bookmark {
    page: number
    label: string
    createdAt: number
  }

  export interface AnnotationFile {
    version: "1.0"
    pdfStorePath: string
    annotations: Annotation[]
    bookmarks: Bookmark[]
    lastReadPage: number
  }

  export const DEFAULT_SETTINGS: Settings = {
    translatePrompt:
      "请将以下英文内容翻译成中文，保留所有专业术语的英文原文，在首次出现时补充中文说明；数学公式保持不变，并尽量保留原文段落结构。",
    questionPrompt:
      "用户正在阅读一份 PDF 文档，并选中了以下内容：\n\n【选中内容】\n{selected_content}\n\n用户的问题是：{user_question}\n\n你可以参考以下相关页面内容来辅助回答：\n\n【参考页面内容】\n{context_pages}\n\n请围绕用户选中的内容，结合参考页面，给出清晰、准确的回答。",
    firstReadPrompt:
      "请先通读这份 PDF 文档，概括它的主要内容、整体结构和核心观点。接下来用户可能会针对文档中的具体内容继续提问，请在回答时参考你对全文的理解。",
    contextPageRange: 1,
    autoFirstRead: true,
  }
}
