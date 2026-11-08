// Realtime page images for the Aether PDF viewer. The host renders display-list paragraphs into a
// transparent page image; this script places it over the PDF.js page so the viewer keeps its own
// toolbar, zoom, scroll, search and page navigation.
;(function () {
  const CHANNEL = "aether-pdf-viewer"
  const ORIGIN = window.location.origin === "null" ? "*" : window.location.origin
  const overlays = new Map()
  const requested = new Map()
  let configSrc = ""
  let realtimeEnabled = false
  let bound = false
  let caret = null
  let caretTimer = 0
  let caretStyle = false

  function post(type, payload) {
    window.parent?.postMessage({ channel: CHANNEL, type, ...(payload || {}) }, ORIGIN)
  }

  function pageElement(page) {
    return document.querySelector('.page[data-page-number="' + page + '"]')
  }

  function wrapper(page) {
    return pageElement(page)?.querySelector(".canvasWrapper") || null
  }

  function ensure(page) {
    const box = wrapper(page)
    if (!box) return
    let canvas = overlays.get(page)
    if (canvas && canvas.parentElement === box) return canvas
    canvas = document.createElement("canvas")
    canvas.className = "aether-realtime-overlay"
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;"
    box.style.position = "relative"
    box.appendChild(canvas)
    overlays.set(page, canvas)
    return canvas
  }

  function clear(page) {
    const canvas = overlays.get(page)
    if (!canvas) return
    canvas.width = 0
    canvas.height = 0
    canvas.remove()
    overlays.delete(page)
  }

  function reset() {
    for (const page of [...overlays.keys()]) clear(page)
    requested.clear()
    clearCaret()
  }

  function sameSource(value) {
    if (!value) return true
    const strip = (input) => input.replace(/([?&])r=\d+$/, "")
    return strip(value) === strip(configSrc)
  }

  function ensureCaretStyle() {
    if (caretStyle) return
    caretStyle = true
    const style = document.createElement("style")
    style.textContent =
      ".aether-realtime-caret{position:absolute;pointer-events:none;z-index:6;width:2px;border-radius:1px;background:#d69e00;box-shadow:0 0 0 1px rgba(214,158,0,.25);animation:aether-realtime-blink 1s steps(1) infinite}@keyframes aether-realtime-blink{50%{opacity:0}}"
    document.head.appendChild(style)
  }

  function clearCaret() {
    clearTimeout(caretTimer)
    caretTimer = 0
    caret = null
    document.querySelectorAll(".aether-realtime-caret").forEach((node) => node.remove())
  }

  function placeCaret() {
    if (!caret) return
    const page = pageElement(caret.page)
    const view = window.PDFViewerApplication?.pdfViewer?.getPageView?.(caret.page - 1)
    const box = page?.querySelector(".canvasWrapper")?.getBoundingClientRect()
    if (!page || !view?.viewport || !box?.width || !box?.height) return
    const point = view.viewport.convertToViewportPoint(caret.x, caret.y)
    if (!point || !point.every(Number.isFinite)) return
    const bounds = page.getBoundingClientRect()
    ensureCaretStyle()
    let node = page.querySelector(".aether-realtime-caret")
    if (!node) {
      node = document.createElement("div")
      node.className = "aether-realtime-caret"
      node.setAttribute("aria-hidden", "true")
      page.appendChild(node)
    }
    const height = Math.max(4, caret.size * (view.viewport.scale || 1) * (box.height / view.viewport.height))
    node.style.left = box.left - bounds.left + point[0] * (box.width / view.viewport.width) - 1 + "px"
    node.style.top = box.top - bounds.top + point[1] * (box.height / view.viewport.height) - height + "px"
    node.style.height = height + "px"
  }

  function showCaret(data) {
    if (!sameSource(data.src)) return
    if (!Number.isInteger(data.page) || data.page < 1) return
    if (![data.x, data.y, data.size].every((value) => Number.isFinite(value))) return
    if (data.size <= 0 || data.size > 1000) return
    const app = window.PDFViewerApplication
    if (app?.pdfDocument && data.page > app.pdfDocument.numPages) return
    caret = { page: data.page, x: data.x, y: data.y, size: data.size }
    app?.pdfViewer?.scrollPageIntoView?.({
      pageNumber: data.page,
      destArray: [null, { name: "XYZ" }, data.x, data.y + data.size, null],
      ignoreDestinationZoom: true,
    })
    placeCaret()
    requestAnimationFrame(placeCaret)
    clearTimeout(caretTimer)
    caretTimer = setTimeout(clearCaret, 4000)
  }

  function request(page) {
    const box = wrapper(page)
    if (!box) return
    const width = box.clientWidth
    const height = box.clientHeight
    if (!width || !height) return
    const dpr = window.devicePixelRatio || 1
    const key = width + "x" + height + "@" + dpr
    if (requested.get(page) === key) return
    requested.set(page, key)
    post("realtime-page-request", { page, width, height, dpr, src: configSrc })
  }

  function visible() {
    if (!realtimeEnabled) return
    const height = window.innerHeight || 1
    const width = window.innerWidth || 1
    for (const page of document.querySelectorAll(".page[data-page-number]")) {
      const rect = page.getBoundingClientRect()
      if (rect.bottom <= 0 || rect.top >= height || rect.right <= 0 || rect.left >= width) continue
      const number = Number(page.getAttribute("data-page-number"))
      if (number) request(number)
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data
    if (!data || data.channel !== CHANNEL) return
    if (event.source !== window.parent) return
    if (ORIGIN !== "*" && event.origin !== window.location.origin) return
    if (data.type === "config") {
      configSrc = typeof data.config?.src === "string" ? data.config.src : ""
      const enabled = !!data.config?.realtime
      if (enabled && !realtimeEnabled) setTimeout(visible, 0)
      if (!enabled && realtimeEnabled) reset()
      realtimeEnabled = enabled
      return
    }
    if (data.type === "realtime-page") {
      if (!sameSource(data.src)) return
      const canvas = ensure(data.page)
      if (!canvas || !data.bitmap) return
      const bitmap = data.bitmap
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext("2d")
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(bitmap, 0, 0)
      }
      if (typeof bitmap.close === "function") bitmap.close()
      return
    }
    if (data.type === "realtime-page-clear") {
      if (!sameSource(data.src)) return
      requested.delete(data.page)
      clear(data.page)
      return
    }
    if (data.type === "realtime-caret") {
      showCaret(data)
      return
    }
    if (data.type === "realtime-reset") {
      reset()
      return
    }
  })

  function bind() {
    if (bound) return
    const app = window.PDFViewerApplication
    if (!app?.eventBus) {
      setTimeout(bind, 200)
      return
    }
    bound = true
    app.eventBus.on("pagerendered", (event) => {
      if (!realtimeEnabled || !event?.pageNumber) return
      requested.delete(event.pageNumber)
      request(event.pageNumber)
      if (caret?.page === event.pageNumber) placeCaret()
    })
    app.eventBus.on("pagesloaded", () => {
      if (!realtimeEnabled) return
      // A new layout PDF replaces the page DOM; every overlay belongs to the previous layout.
      reset()
      visible()
    })
    app.eventBus.on("updateviewarea", () => {
      if (!realtimeEnabled) return
      visible()
      placeCaret()
    })
  }

  window.addEventListener("resize", () => {
    visible()
    placeCaret()
  })
  document.addEventListener("webviewerloaded", bind)
  bind()
})()
