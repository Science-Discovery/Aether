export type LayoutVariant = "two-pane" | "tree" | "review" | "review-tree"

export type ReadingLayoutMode =
  | "two-left"
  | "two-right"
  | "tree-left"
  | "tree-right"
  | "review-left"
  | "review-right"
  | "review-tree-left"
  | "review-tree-right"

export const SIDEBAR_MIN = 81
export const SESSION_MIN = 150
export const REVIEW_MIN = 107
export const TREE_MIN = 67
export const CHAT_MIN = 120

export const VARIANT_DEFAULTS: Record<LayoutVariant, { pdf: number; chat: number }> = {
  "two-pane": { pdf: 0.55, chat: 0.45 },
  tree: { pdf: 0.5, chat: 0.35 },
  review: { pdf: 0.4, chat: 0.25 },
  "review-tree": { pdf: 0.4, chat: 0.25 },
}

export const FILE_TREE_RATIOS: Record<LayoutVariant, number> = {
  "two-pane": 0,
  tree: 0.15,
  review: 0,
  "review-tree": 0.12,
}

export const PDF_RATIO_BOUNDS: Record<LayoutVariant, { min: number; max: number }> = {
  "two-pane": { min: 0.1, max: 0.9 },
  tree: { min: 0.1, max: 0.9 },
  review: { min: 0.1, max: 0.9 },
  "review-tree": { min: 0.1, max: 0.9 },
}

export const CHAT_RATIO_BOUNDS: Partial<Record<LayoutVariant, { min: number; max: number }>> = {
  review: { min: 0.0833, max: 0.9 },
  "review-tree": { min: 0.0833, max: 0.9 },
}

export function getReadingLayoutVariant(reviewOpen: boolean, fileTreeOpen: boolean): LayoutVariant {
  if (reviewOpen && fileTreeOpen) return "review-tree"
  if (reviewOpen) return "review"
  if (fileTreeOpen) return "tree"
  return "two-pane"
}

export function getReadingLayoutMode(variant: LayoutVariant, layoutSwapped: boolean): ReadingLayoutMode {
  switch (variant) {
    case "two-pane":
      return layoutSwapped ? "two-right" : "two-left"
    case "tree":
      return layoutSwapped ? "tree-right" : "tree-left"
    case "review":
      return layoutSwapped ? "review-right" : "review-left"
    case "review-tree":
      return layoutSwapped ? "review-tree-right" : "review-tree-left"
  }
}
