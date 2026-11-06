// These libraries are reached only by lazy document previews and module workers.
// Discovering them after the dev client connects would invalidate Vite's shared
// dependency graph and reload the entire window. Serve native ESM on demand;
// prebundle only the CommonJS entries needed by those lazy imports.
export default {
  exclude: [
    "docx-preview",
    "@aiden0z/pptx-renderer",
    "@tanstack/solid-virtual",
    "@tanstack/virtual-core",
    "parse5",
    "entities",
    "css-tree",
    "echarts",
    "zrender",
  ],
  include: [
    "@opencode-ai/app > exceljs",
    "@opencode-ai/app > ssf",
    "@opencode-ai/app > docx-preview > jszip",
    "@opencode-ai/app > @aiden0z/pptx-renderer > jszip",
  ],
}
