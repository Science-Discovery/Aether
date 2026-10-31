const en = {
  loading: "Loading workbook…",
  cancel: "Cancel",
  cancelled: "Workbook preview cancelled.",
  timeout: "Workbook parsing timed out. Reload the preview to try again.",
  failed: "Unable to preview this workbook.",
  sheets: "Worksheets",
  grid: "Spreadsheet preview",
  uncalculated: "Formula not calculated",
  image: "Worksheet image",
  formatting: "Some cells use unsupported number formats. Their original values are shown.",
  readonly: "Read-only preview · Basic cells and images",
  limitations:
    "Charts, conditional formatting, and pivot tables are not rendered. Formulas use saved results and are not recalculated.",
}
const zh: typeof en = {
  loading: "正在加载工作簿…",
  cancel: "取消",
  cancelled: "已取消工作簿预览。",
  timeout: "工作簿解析超时，请重新加载预览后重试。",
  failed: "无法预览此工作簿。",
  sheets: "工作表",
  grid: "电子表格预览",
  uncalculated: "公式未计算",
  image: "工作表图片",
  formatting: "部分单元格的数字格式未完全支持，已显示原始数值。",
  readonly: "只读预览 · 基础单元格与图片",
  limitations: "不显示图表、条件格式和透视表。公式使用已保存的结果，不重新计算。",
}
const zht: typeof en = {
  loading: "正在載入活頁簿…",
  cancel: "取消",
  cancelled: "已取消活頁簿預覽。",
  timeout: "活頁簿解析逾時，請重新載入預覽後再試。",
  failed: "無法預覽此活頁簿。",
  sheets: "工作表",
  grid: "試算表預覽",
  uncalculated: "公式尚未計算",
  image: "工作表圖片",
  formatting: "部分儲存格的數字格式未完全支援，已顯示原始數值。",
  readonly: "唯讀預覽 · 基本儲存格與圖片",
  limitations: "不顯示圖表、條件格式和樞紐分析表。公式使用已儲存的結果，不重新計算。",
}
export const text = (locale: string) => (locale === "zh" ? zh : locale === "zht" ? zht : en)
