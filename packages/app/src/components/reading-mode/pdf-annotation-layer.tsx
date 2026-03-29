import { type ReadingHighlight, type ReadingHighlightColor } from "@/context/reading-mode"

const FILL: Record<ReadingHighlightColor, string> = {
  yellow: "rgba(250, 204, 21, 0.35)",
  red: "rgba(248, 113, 113, 0.30)",
  green: "rgba(74, 222, 128, 0.30)",
  blue: "rgba(96, 165, 250, 0.30)",
}

export function renderAnnotationLayer(pageElement: HTMLDivElement, annotations: ReadingHighlight[]) {
  const existing = pageElement.querySelector<HTMLDivElement>("[data-reading-annotation-overlay='true']")
  if (annotations.length === 0) {
    existing?.remove()
    return
  }

  const overlay = existing ?? document.createElement("div")
  overlay.dataset.readingAnnotationOverlay = "true"
  overlay.className = "reading-annotation-overlay"

  const fragment = document.createDocumentFragment()
  for (const annotation of annotations) {
    for (const rect of annotation.rects) {
      const node = document.createElement("div")
      node.className = "reading-annotation-rect"
      node.dataset.annotationId = annotation.id
      node.dataset.annotationColor = annotation.color
      node.style.left = `${rect.x1 * 100}%`
      node.style.top = `${rect.y1 * 100}%`
      node.style.width = `${(rect.x2 - rect.x1) * 100}%`
      node.style.height = `${(rect.y2 - rect.y1) * 100}%`
      node.style.backgroundColor = FILL[annotation.color]
      fragment.appendChild(node)
    }
  }

  overlay.replaceChildren(fragment)

  if (!existing) {
    pageElement.appendChild(overlay)
  }
}
