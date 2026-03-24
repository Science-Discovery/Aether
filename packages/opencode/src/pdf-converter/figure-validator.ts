/**
 * 图片 bbox 验证模块（移植自 figure_validator.py）
 *
 * 纯代码验证，不调用 LLM。
 */

import type { FigureInfo, FormulaFigureInfo } from "./types"

type Bbox = [number, number, number, number]

export interface BboxValidationResult {
  valid: boolean
  message: string
  warnings: string[]
}

/**
 * 验证 bbox 坐标是否在合法范围内 [0, 1]
 */
export function validateBboxBounds(bbox: Bbox, figureId: string): { valid: boolean; message: string } {
  const [x0, y0, x1, y1] = bbox
  const BOUND_LIMIT = 1.5
  const NEG_LIMIT = -0.05

  const outOfRange = (
    [["x0", x0], ["y0", y0], ["x1", x1], ["y1", y1]] as [string, number][]
  ).filter(([, val]) => val > BOUND_LIMIT || val < NEG_LIMIT)

  if (outOfRange.length > 0) {
    const coords = outOfRange.map(([n, v]) => `${n}=${v.toFixed(3)}`).join(", ")
    return { valid: false, message: `图片 ${figureId}: bbox 坐标超出范围 [0,1]（${coords}）` }
  }

  if (x1 <= x0) return { valid: false, message: `图片 ${figureId}: x 坐标反向（x0=${x0.toFixed(3)} >= x1=${x1.toFixed(3)}）` }
  if (y1 <= y0) return { valid: false, message: `图片 ${figureId}: y 坐标反向（y0=${y0.toFixed(3)} >= y1=${y1.toFixed(3)}）` }

  return { valid: true, message: "" }
}

/**
 * 验证 bbox 的最小宽度（防止小数点位移错误）
 */
export function validateBboxPosition(bbox: Bbox, figureId: string): { valid: boolean; message: string } {
  const [x0, , x1] = bbox
  const width = x1 - x0
  if (width < 0.03) {
    return {
      valid: false,
      message: `图片 ${figureId}: 宽度过小 (${width.toFixed(3)} < 0.03)，疑似坐标小数点位移错误`,
    }
  }
  return { valid: true, message: "" }
}

/**
 * 验证宽高比
 */
export function validateAspectRatio(
  bbox: Bbox,
  figureId: string,
  minRatio: number = 0.1,
  maxRatio: number = 1.5,
): { valid: boolean; message: string } {
  const [x0, y0, x1, y1] = bbox
  const width = x1 - x0
  const height = y1 - y0

  if (width <= 0.01 || height <= 0.01) {
    return { valid: false, message: `图片 ${figureId}: 尺寸过小 (w=${width.toFixed(3)}, h=${height.toFixed(3)})` }
  }

  const ratio = height / width

  // 窄图例外
  let effectiveMax = maxRatio
  if (width < 0.10 && width >= 0.03) {
    effectiveMax = Math.max(maxRatio, 10.0)
  }

  if (ratio > effectiveMax) {
    return { valid: false, message: `图片 ${figureId}: 高宽比过大 (${ratio.toFixed(2)} > ${effectiveMax})` }
  }
  if (ratio < minRatio) {
    return { valid: false, message: `图片 ${figureId}: 高宽比过小 (${ratio.toFixed(2)} < ${minRatio})` }
  }

  return { valid: true, message: "" }
}

/**
 * 收集 bbox 软警告
 */
export function collectBboxWarnings(bbox: Bbox, figureId: string): string[] {
  const [x0, y0, x1, y1] = bbox
  const width = x1 - x0
  const height = y1 - y0
  const warnings: string[] = []

  // 水平中心偏离检查
  const centerX = (x0 + x1) / 2
  if (centerX < 0.15 || centerX > 0.85) {
    warnings.push(
      `图片 ${figureId} 水平中心 (${centerX.toFixed(3)}) 严重偏离页面中心，请检查 x0 和 x1 的小数点位置`,
    )
  }

  // 面积过小检查
  const area = width * height
  if (area < 0.01) {
    warnings.push(`图片 ${figureId} 面积过小 (${area.toFixed(4)})，请检查 bbox 坐标的小数点位置`)
  }

  return warnings
}

/**
 * 尝试修复坐标越界的 bbox
 */
export function tryNormalizeBbox(bbox: Bbox, figureId: string): { bbox: Bbox | null; message: string } {
  const [x0, y0, x1, y1] = bbox
  const coords: [string, number][] = [["x0", x0], ["y0", y0], ["x1", x1], ["y1", y1]]

  const outOfRange = coords.filter(([, val]) => val > 1.5)
  if (outOfRange.length === 0) return { bbox, message: "坐标在合法范围内" }

  const repaired: Record<string, number> = { x0, y0, x1, y1 }

  for (const [name, val] of outOfRange) {
    let fixed = false
    for (const divisor of [10, 100, 1000]) {
      const candidate = Math.round((val / divisor) * 10000) / 10000
      if (candidate >= 0 && candidate <= 1) {
        repaired[name] = candidate
        fixed = true
        break
      }
    }
    if (!fixed) {
      return { bbox: null, message: `图片 ${figureId}: 坐标 ${name}=${val} 无法自动修复` }
    }
  }

  return {
    bbox: [repaired.x0, repaired.y0, repaired.x1, repaired.y1],
    message: `图片 ${figureId}: 自动修复了超界坐标`,
  }
}

/**
 * 验证公式图片的 bbox
 */
export function validateFormulaFigureBbox(
  bbox: Bbox,
  figureId: string,
): { valid: boolean; message: string } {
  const bounds = validateBboxBounds(bbox, figureId)
  if (!bounds.valid) return bounds

  const pos = validateBboxPosition(bbox, figureId)
  if (!pos.valid) return pos

  const [x0, y0, x1, y1] = bbox
  const width = x1 - x0
  const height = y1 - y0
  if (width <= 0.01 || height <= 0.01) {
    return { valid: false, message: `公式图片 ${figureId}: 尺寸过小` }
  }

  const ratio = height / width
  if (ratio > 5.0) {
    return { valid: false, message: `公式图片 ${figureId}: 高宽比过大 (${ratio.toFixed(2)} > 5.0)` }
  }
  if (ratio < 0.02) {
    return { valid: false, message: `公式图片 ${figureId}: 高宽比过小 (${ratio.toFixed(2)} < 0.02)` }
  }

  return { valid: true, message: "" }
}

/**
 * 综合验证普通图片
 */
export function validateFigure(figure: FigureInfo): BboxValidationResult {
  const warnings: string[] = []

  // 尝试修复
  const normalized = tryNormalizeBbox(figure.bbox, figure.figure_id)
  const bbox = normalized.bbox ?? figure.bbox

  // 范围验证
  const bounds = validateBboxBounds(bbox, figure.figure_id)
  if (!bounds.valid) return { valid: false, message: bounds.message, warnings }

  // 位置验证
  const pos = validateBboxPosition(bbox, figure.figure_id)
  if (!pos.valid) return { valid: false, message: pos.message, warnings }

  // 宽高比验证
  const aspect = validateAspectRatio(bbox, figure.figure_id)
  if (!aspect.valid) return { valid: false, message: aspect.message, warnings }

  // 居中性检查
  const centerX = (bbox[0] + bbox[2]) / 2
  if (centerX < 0.30 || centerX > 0.70) {
    warnings.push(`图片 ${figure.figure_id} 水平中心 (${centerX.toFixed(3)}) 偏离页面中心`)
  }

  // 收集更多软警告
  warnings.push(...collectBboxWarnings(bbox, figure.figure_id))

  return { valid: true, message: "", warnings }
}

/**
 * 综合验证公式图片
 */
export function validateFormulaFigure(ffig: FormulaFigureInfo): BboxValidationResult {
  const result = validateFormulaFigureBbox(ffig.bbox, ffig.ffig_id)
  return { valid: result.valid, message: result.message, warnings: [] }
}

/**
 * 验证 figure_count 是否匹配
 */
export function validateFigureCount(
  reportedCount: number,
  figures: FigureInfo[],
): { valid: boolean; message: string } {
  if (reportedCount !== figures.length) {
    return {
      valid: false,
      message: `文字提取报告 figure_count=${reportedCount}，但实际提取到 ${figures.length} 个图片 bbox`,
    }
  }
  return { valid: true, message: "" }
}
