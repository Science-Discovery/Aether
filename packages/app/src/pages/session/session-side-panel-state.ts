import { SESSION_MIN, TREE_MIN } from "@/pages/session/reading-layout"

export function panel(input: {
  desktop: boolean
  review_override?: boolean
  file_override?: boolean
  review_open: boolean
  file_open: boolean
  width_override?: number
  session_width: number
  tree_width_override?: number
  tree_width: number
}) {
  const review =
    input.desktop && (typeof input.review_override === "boolean" ? input.review_override : input.review_open)
  const file = input.desktop && (typeof input.file_override === "boolean" ? input.file_override : input.file_open)
  const open = review || file
  const tree = typeof input.tree_width_override === "number" ? Math.max(0, input.tree_width_override) : input.tree_width
  const clamped = Math.max(TREE_MIN, tree)
  const width =
    typeof input.width_override === "number"
      ? `${Math.max(0, input.width_override)}px`
      : !open
        ? "0px"
        : review
          ? `calc(100% - ${Math.max(SESSION_MIN, input.session_width)}px)`
          : `${clamped}px`

  return {
    review,
    file,
    open,
    review_tab: input.desktop,
    panel_width: width,
    tree_width: file ? `${clamped}px` : "0px",
  }
}

export function tab(input: { current: "changes" | "all"; next: string }) {
  if (input.next !== "changes" && input.next !== "all") return input.current
  return input.next
}

export function all(input: { current: "changes" | "all" }) {
  if (input.current !== "changes") return input.current
  return "all"
}
