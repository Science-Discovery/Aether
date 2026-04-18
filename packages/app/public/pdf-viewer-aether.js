"use strict";

(function () {
  const CHANNEL = "aether-pdf-viewer";
  const ORIGIN = window.location.origin;
  const C_MAP_URL = "/pdfjs-ref/web/cmaps/";
  const STANDARD_FONT_DATA_URL = "/pdfjs-ref/web/standard_fonts/";
  const RANGE_CHUNK_SIZE = 65536;
  const DEFAULT_SCALE = {
    full: "auto",
    compact: "page-width",
  };

  let currentConfig = null;
  let currentKey = "";
  let eventsBound = false;
  let suppressSidebarTracking = false;
  let sidebarState = {
    initialized: false,
    userClosed: false,
  };
  let selectionMenu = null;
  let selectionHint = null;
  let selectionHintTimer = 0;
  let selectionHintLockedUntil = 0;
  let selectionState = null;
  let captureOverlay = null;
  let captureBox = null;
  let captureModeActive = false;
  let captureDrag = null;

  function post(type, payload) {
    window.parent?.postMessage({ channel: CHANNEL, type, ...(payload || {}) }, ORIGIN);
  }

  function mapScrollMode(name) {
    switch (name) {
      case "horizontal":
        return 1;
      case "wrapped":
        return 2;
      default:
        return 0;
    }
  }

  function outlineSidebarView() {
    return window.PDFViewerApplicationConstants?.SidebarView?.OUTLINE ?? 2;
  }

  function sanitizeConfig(input) {
    const mode = input?.mode === "compact" ? "compact" : "full";
    return {
      src: typeof input?.src === "string" ? input.src : "",
      authHeader: typeof input?.authHeader === "string" && input.authHeader ? input.authHeader : undefined,
      mode,
      nightMode: !!input?.nightMode,
      layoutSwapped: !!input?.layoutSwapped,
      page:
        typeof input?.page === "number" && Number.isFinite(input.page) && input.page > 0
          ? Math.round(input.page)
          : 1,
      scale: typeof input?.scale === "string" && input.scale ? input.scale : DEFAULT_SCALE[mode],
      scrollMode:
        input?.scrollMode === "horizontal" || input?.scrollMode === "wrapped" ? input.scrollMode : "vertical",
      features: {
        pdf2md: !!input?.features?.pdf2md,
        readingMode: !!input?.features?.readingMode,
        settings: !!input?.features?.settings,
        textSelectionActions: !!input?.features?.textSelectionActions,
        imageSelectionActions: !!input?.features?.imageSelectionActions,
      },
    };
  }

  function selectionActionsEnabled() {
    return !!(
      currentConfig &&
      currentConfig.mode === "full" &&
      currentConfig.features &&
      currentConfig.features.textSelectionActions
    );
  }

  function imageSelectionActionsEnabled() {
    return !!(
      currentConfig &&
      currentConfig.mode === "full" &&
      currentConfig.features &&
      currentConfig.features.imageSelectionActions
    );
  }

  function ensureSelectionUi() {
    if (!selectionMenu) {
      selectionMenu = document.createElement("div");
      selectionMenu.id = "aetherSelectionMenu";
      selectionMenu.hidden = true;

      [
        { action: "copy", label: "Copy" },
        { action: "translate", label: "Translate" },
        { action: "ask", label: "Ask" },
      ].forEach(function (item) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "aetherSelectionMenuButton";
        button.dataset.action = item.action;
        button.textContent = item.label;
        button.addEventListener("mousedown", function (event) {
          event.preventDefault();
        });
        button.addEventListener("click", function (event) {
          event.preventDefault();
          handleSelectionAction(item.action);
        });
        selectionMenu.appendChild(button);
      });

      document.body.appendChild(selectionMenu);
    }

    if (!selectionHint) {
      selectionHint = document.createElement("div");
      selectionHint.id = "aetherSelectionHint";
      selectionHint.hidden = true;
      document.body.appendChild(selectionHint);
    }
  }

  function ensureCaptureUi() {
    if (captureOverlay) return;
    captureOverlay = document.createElement("div");
    captureOverlay.id = "aetherCaptureOverlay";
    captureOverlay.hidden = true;

    const shade = document.createElement("div");
    shade.id = "aetherCaptureShade";
    captureOverlay.appendChild(shade);

    captureBox = document.createElement("div");
    captureBox.id = "aetherCaptureBox";
    captureBox.hidden = true;
    captureOverlay.appendChild(captureBox);

    document.body.appendChild(captureOverlay);
  }

  function hideSelectionHint(force) {
    if (!selectionHint) return;
    if (!force && Date.now() < selectionHintLockedUntil) return;
    selectionHint.hidden = true;
    selectionHint.textContent = "";
    if (selectionHintTimer) {
      clearTimeout(selectionHintTimer);
      selectionHintTimer = 0;
    }
    selectionHintLockedUntil = 0;
  }

  function showSelectionHint(message, duration) {
    ensureSelectionUi();
    hideSelectionMenu();
    hideSelectionHint(true);
    selectionHint.textContent = message;
    selectionHint.hidden = false;
    selectionHintLockedUntil = Date.now() + (duration || 2000);
    selectionHintTimer = window.setTimeout(function () {
      hideSelectionHint(true);
    }, duration || 2000);
  }

  function hideSelectionMenu() {
    if (!selectionMenu) return;
    selectionMenu.hidden = true;
    selectionState = null;
  }

  function hideSelectionUi() {
    hideSelectionMenu();
    hideSelectionHint(true);
  }

  function clearTextSelection() {
    const selection = window.getSelection();
    selection?.removeAllRanges();
  }

  async function handleSelectionAction(action) {
    if (!selectionState) return;

    if (action === "copy") {
      let imageCopyUnsupported = false;
      try {
        if (selectionState.kind === "image") {
          if (
            navigator.clipboard?.write &&
            window.ClipboardItem &&
            selectionState.imageBlob
          ) {
            await navigator.clipboard.write([
              new window.ClipboardItem({
                [selectionState.imageBlob.type || "image/png"]: selectionState.imageBlob,
              }),
            ]);
          } else {
            imageCopyUnsupported = true;
          }
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(selectionState.text);
        } else {
          document.execCommand?.("copy");
        }
      } catch (_) {
        // Keep the native selection as fallback.
      }
      if (imageCopyUnsupported) {
        hideSelectionMenu();
        showSelectionHint("Image copy not supported");
        return;
      }
      clearTextSelection();
      hideSelectionUi();
      return;
    }

    if (selectionState.kind === "image") {
      post("imageselectionaction", {
        action,
        page: selectionState.page,
        imageDataUrl: selectionState.imageDataUrl,
      });
    } else {
      post("textselectionaction", {
        action,
        page: selectionState.page,
        text: selectionState.text,
      });
    }
    clearTextSelection();
    hideSelectionUi();
  }

  function pageNumberFromElement(element) {
    const raw = element?.dataset?.pageNumber || element?.getAttribute?.("data-page-number");
    const page = Number(raw);
    return Number.isFinite(page) && page > 0 ? page : undefined;
  }

  function closestPageElement(node) {
    if (!node) return null;
    if (node instanceof Element) return node.closest(".page");
    return node.parentElement?.closest(".page") ?? null;
  }

  function normalizeSelectedText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function getSelectionContext() {
    if (!selectionActionsEnabled()) return null;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

    const range = selection.getRangeAt(0);
    const text = normalizeSelectedText(selection.toString());
    if (!text) return null;

    const startPage = closestPageElement(range.startContainer);
    const endPage = closestPageElement(range.endContainer);
    const startPageNumber = pageNumberFromElement(startPage);
    const endPageNumber = pageNumberFromElement(endPage);

    if (!startPageNumber || !endPageNumber) return null;
    if (startPageNumber !== endPageNumber) {
      return { error: "cross-page" };
    }

    const rect = range.getBoundingClientRect();
    if ((!rect.width && !rect.height) || !Number.isFinite(rect.top) || !Number.isFinite(rect.left)) {
      return null;
    }

    return {
      page: startPageNumber,
      text,
      rect,
    };
  }

  function positionSelectionMenu(rect) {
    if (!selectionMenu) return;

    const menuRect = selectionMenu.getBoundingClientRect();
    const top = Math.max(12, rect.top - menuRect.height - 10);
    const left = Math.min(
      window.innerWidth - menuRect.width - 12,
      Math.max(12, rect.left + rect.width / 2 - menuRect.width / 2),
    );

    selectionMenu.style.top = top + "px";
    selectionMenu.style.left = left + "px";
  }

  function updateSelectionUi() {
    if (!selectionActionsEnabled()) {
      hideSelectionUi();
      return;
    }

    if (captureModeActive || captureDrag) {
      hideSelectionMenu();
      return;
    }

    const context = getSelectionContext();
    if (!context) {
      hideSelectionMenu();
      return;
    }

    if (context.error === "cross-page") {
      showSelectionHint("Single-page text selections only", 2200);
      return;
    }

    ensureSelectionUi();
    hideSelectionHint();
    selectionState = {
      kind: "text",
      page: context.page,
      text: context.text,
    };
    selectionMenu.hidden = false;
    positionSelectionMenu(context.rect);
  }

  function scheduleSelectionUiUpdate() {
    window.setTimeout(updateSelectionUi, 0);
  }

  function setCaptureMode(next) {
    const enabled = !!next && imageSelectionActionsEnabled();
    captureModeActive = enabled;
    document.body.classList.toggle("capture-mode-active", enabled);

    const button = document.getElementById("aetherCaptureRegion");
    if (button) {
      button.classList.toggle("toggled", enabled);
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      button.title = enabled ? "Exit capture mode" : "Capture region";
    }

    ensureCaptureUi();
    if (captureOverlay) {
      captureOverlay.hidden = !enabled;
    }
    if (captureBox) {
      captureBox.hidden = true;
      captureBox.style.left = "0px";
      captureBox.style.top = "0px";
      captureBox.style.width = "0px";
      captureBox.style.height = "0px";
    }
    captureDrag = null;
    if (enabled) {
      hideSelectionUi();
      clearTextSelection();
    }
  }

  function viewerContainerElement() {
    return document.getElementById("viewerContainer");
  }

  function pageCanvasForElement(pageElement) {
    return pageElement?.querySelector?.(".canvasWrapper canvas") || pageElement?.querySelector?.("canvas") || null;
  }

  function currentPointerPoint(event) {
    return { x: event.clientX, y: event.clientY };
  }

  function updateCaptureBox(start, current) {
    if (!captureBox) return;
    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    captureBox.hidden = false;
    captureBox.style.left = left + "px";
    captureBox.style.top = top + "px";
    captureBox.style.width = width + "px";
    captureBox.style.height = height + "px";
  }

  function cropImageFromSelection(pageElement, rect) {
    const canvas = pageCanvasForElement(pageElement);
    if (!canvas) return Promise.resolve(null);

    const canvasRect = canvas.getBoundingClientRect();
    const cropLeft = Math.max(rect.left, canvasRect.left);
    const cropTop = Math.max(rect.top, canvasRect.top);
    const cropRight = Math.min(rect.right, canvasRect.right);
    const cropBottom = Math.min(rect.bottom, canvasRect.bottom);
    const cropWidth = cropRight - cropLeft;
    const cropHeight = cropBottom - cropTop;

    if (!(cropWidth > 2 && cropHeight > 2)) {
      return Promise.resolve(null);
    }

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const sourceX = Math.max(0, Math.round((cropLeft - canvasRect.left) * scaleX));
    const sourceY = Math.max(0, Math.round((cropTop - canvasRect.top) * scaleY));
    const sourceWidth = Math.min(canvas.width - sourceX, Math.round(cropWidth * scaleX));
    const sourceHeight = Math.min(canvas.height - sourceY, Math.round(cropHeight * scaleY));

    if (!(sourceWidth > 1 && sourceHeight > 1)) {
      return Promise.resolve(null);
    }

    const output = document.createElement("canvas");
    output.width = sourceWidth;
    output.height = sourceHeight;
    const context = output.getContext("2d");
    if (!context) return Promise.resolve(null);

    context.drawImage(
      canvas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight,
    );

    return new Promise(function (resolve) {
      output.toBlob(function (blob) {
        if (!blob) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.addEventListener("load", function () {
          resolve({
            blob: blob,
            imageDataUrl: typeof reader.result === "string" ? reader.result : "",
          });
        });
        reader.addEventListener("error", function () {
          resolve(null);
        });
        reader.readAsDataURL(blob);
      }, "image/png");
    });
  }

  async function finalizeCapture(event) {
    if (!captureDrag) return;

    const drag = captureDrag;
    captureDrag = null;
    const point = currentPointerPoint(event);
    updateCaptureBox(drag.start, point);

    const endPage = closestPageElement(event.target);
    const endPageNumber = pageNumberFromElement(endPage);
    if (!endPageNumber || endPageNumber !== drag.page) {
      showSelectionHint("Single-page selections only", 2200);
      setCaptureMode(false);
      return;
    }

    const rect = {
      left: Math.min(drag.start.x, point.x),
      top: Math.min(drag.start.y, point.y),
      right: Math.max(drag.start.x, point.x),
      bottom: Math.max(drag.start.y, point.y),
    };

    const cropped = await cropImageFromSelection(drag.pageElement, rect);
    if (!cropped || !cropped.imageDataUrl) {
      showSelectionHint("Unable to capture region");
      setCaptureMode(false);
      return;
    }

    ensureSelectionUi();
    hideSelectionHint();
    selectionState = {
      kind: "image",
      page: drag.page,
      imageDataUrl: cropped.imageDataUrl,
      imageBlob: cropped.blob,
    };
    selectionMenu.hidden = false;
    positionSelectionMenu({
      top: rect.top,
      left: rect.left,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    });
    setCaptureMode(false);
  }

  function applyChrome(config) {
    document.body.dataset.mode = config.mode;
    document.body.dataset.nightMode = config.nightMode ? "on" : "off";
    document.body.dataset.layoutSwapped = config.layoutSwapped ? "on" : "off";
    const outerContainer = document.getElementById("outerContainer");

    const pdf2md = document.getElementById("aetherPdf2md");
    if (pdf2md) {
      pdf2md.hidden = !(config.mode === "compact" && config.features.pdf2md);
      pdf2md.title = "Convert PDF to Markdown";
    }

    const readingMode = document.getElementById("aetherOpenReadingMode");
    if (readingMode) {
      readingMode.hidden = !(config.mode === "compact" && config.features.readingMode);
      readingMode.title = "Open in Reading Mode";
    }

    const captureRegion = document.getElementById("aetherCaptureRegion");
    if (captureRegion) {
      captureRegion.hidden = !(config.mode === "full" && config.features.imageSelectionActions);
      captureRegion.title = captureModeActive ? "Exit capture mode" : "Capture region";
      captureRegion.setAttribute("aria-pressed", captureModeActive ? "true" : "false");
    }

    const readingSettings = document.getElementById("aetherReadingSettings");
    if (readingSettings) {
      readingSettings.hidden = !(config.mode === "full" && config.features.settings);
      readingSettings.title = "Reading settings";
      readingSettings.setAttribute("aria-label", readingSettings.title);
    }

    const nightMode = document.getElementById("aetherNightMode");
    if (nightMode) {
      nightMode.title = config.nightMode ? "Disable night mode" : "Enable night mode";
      nightMode.classList.toggle("toggled", !!config.nightMode);
      nightMode.setAttribute("aria-pressed", config.nightMode ? "true" : "false");
    }

    const swapLayout = document.getElementById("aetherSwapLayout");
    if (swapLayout) {
      swapLayout.hidden = config.mode !== "full";
      swapLayout.title = config.layoutSwapped ? "Move PDF to the left" : "Move PDF to the right";
      swapLayout.setAttribute("aria-label", swapLayout.title);
      swapLayout.setAttribute("aria-pressed", config.layoutSwapped ? "true" : "false");
      swapLayout.dataset.direction = config.layoutSwapped ? "left" : "right";
    }

    if (config.mode === "compact" && outerContainer) {
      outerContainer.classList.remove("sidebarOpen", "sidebarMoving", "sidebarResizing");
    }

    if (!selectionActionsEnabled()) {
      hideSelectionUi();
      clearTextSelection();
    }
    if (!(config.mode === "full" && config.features.imageSelectionActions) && captureModeActive) {
      setCaptureMode(false);
    }
  }

  function rememberSidebarState(isOpen) {
    if (!currentConfig || currentConfig.mode !== "full") return;
    sidebarState.initialized = true;
    sidebarState.userClosed = !isOpen;
  }

  function withSidebarTrackingSuppressed(fn) {
    suppressSidebarTracking = true;
    try {
      fn();
    } finally {
      setTimeout(function () {
        suppressSidebarTracking = false;
      }, 0);
    }
  }

  function hasOutline() {
    const outline = document.getElementById("outlineView");
    return !!outline && outline.children.length > 0;
  }

  function applyDocumentDefaults(config) {
    const app = window.PDFViewerApplication;
    if (!app?.pdfViewer) return;

    app.pdfCursorTools?.switchTool?.(0);
    app.pdfViewer.scrollMode = mapScrollMode(config.scrollMode);
    app.pdfViewer.spreadMode = 0;
    app.pdfViewer.currentScaleValue = config.scale;

    if (config.mode === "full") {
      if (hasOutline() && !sidebarState.userClosed) {
        withSidebarTrackingSuppressed(function () {
          app.pdfSidebar?.switchView?.(outlineSidebarView(), true);
          app.pdfSidebar?.open?.();
        });
      } else {
        withSidebarTrackingSuppressed(function () {
          app.pdfSidebar?.close?.();
        });
      }
    } else {
      withSidebarTrackingSuppressed(function () {
        app.pdfSidebar?.close?.();
      });
      document.getElementById("outerContainer")?.classList.remove("sidebarOpen", "sidebarMoving", "sidebarResizing");
    }

    if (config.page > 1) {
      app.page = config.page;
    }
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    ensureSelectionUi();

    const app = window.PDFViewerApplication;
    const eventBus = app.eventBus;

    eventBus.on("pagechanging", function (evt) {
      if (!evt?.pageNumber) return;
      hideSelectionUi();
      post("pagechange", { page: evt.pageNumber });
    });

    eventBus.on("pagesloaded", function (evt) {
      const totalPages = Number(evt?.pagesCount || window.PDFViewerApplication?.pdfDocument?.numPages || 0);
      if (!Number.isFinite(totalPages) || totalPages <= 0) return;
      post("documentinfo", { totalPages });
    });

    eventBus.on("sidebarviewchanged", function (evt) {
      if (!currentConfig || currentConfig.mode !== "full") return;
      if (suppressSidebarTracking) return;
      rememberSidebarState(!!evt?.view);
    });

    eventBus.on("outlineloaded", function () {
      if (!currentConfig || currentConfig.mode !== "full") return;
      if (hasOutline() && !sidebarState.userClosed) {
        withSidebarTrackingSuppressed(function () {
          app.pdfSidebar?.switchView?.(outlineSidebarView(), true);
          app.pdfSidebar?.open?.();
        });
      } else {
        withSidebarTrackingSuppressed(function () {
          app.pdfSidebar?.close?.();
        });
      }
    });

    const pdf2md = document.getElementById("aetherPdf2md");
    if (pdf2md) {
      pdf2md.addEventListener("click", function () {
        post("pdf2md");
      });
    }

    const readingMode = document.getElementById("aetherOpenReadingMode");
    if (readingMode) {
      readingMode.addEventListener("click", function () {
        post("openreadingmode");
      });
    }

    const nightMode = document.getElementById("aetherNightMode");
    if (nightMode) {
      nightMode.addEventListener("click", function () {
        currentConfig = { ...(currentConfig || sanitizeConfig({})), nightMode: !currentConfig?.nightMode };
        applyChrome(currentConfig);
        post("nightmode", { enabled: currentConfig.nightMode });
      });
    }

    const captureRegion = document.getElementById("aetherCaptureRegion");
    if (captureRegion) {
      captureRegion.addEventListener("click", function () {
        setCaptureMode(!captureModeActive);
      });
    }

    const readingSettings = document.getElementById("aetherReadingSettings");
    if (readingSettings) {
      readingSettings.addEventListener("click", function () {
        post("opensettings");
      });
    }

    const swapLayout = document.getElementById("aetherSwapLayout");
    if (swapLayout) {
      swapLayout.addEventListener("click", function () {
        post("swaplayout");
      });
    }

    document.addEventListener("selectionchange", function () {
      scheduleSelectionUiUpdate();
    });
    document.addEventListener("pointerup", function () {
      scheduleSelectionUiUpdate();
    });
    document.addEventListener("keyup", function (event) {
      if (captureModeActive && event.key === "Escape") {
        setCaptureMode(false);
      }
      scheduleSelectionUiUpdate();
    });
    document.addEventListener("pointerdown", function (event) {
      if (captureModeActive) {
        if (selectionMenu?.contains(event.target)) return;
        if (event.button !== 0) return;
        const pageElement = closestPageElement(event.target);
        const page = pageNumberFromElement(pageElement);
        const viewerContainer = viewerContainerElement();
        if (!pageElement || !page || !viewerContainer) return;
        if (!viewerContainer.contains(event.target)) return;
        event.preventDefault();
        hideSelectionUi();
        clearTextSelection();
        ensureCaptureUi();
        captureDrag = {
          page: page,
          pageElement: pageElement,
          start: currentPointerPoint(event),
        };
        updateCaptureBox(captureDrag.start, captureDrag.start);
        return;
      }
      if (selectionMenu?.contains(event.target)) return;
      hideSelectionUi();
    });
    document.addEventListener("pointermove", function (event) {
      if (!captureDrag) return;
      event.preventDefault();
      updateCaptureBox(captureDrag.start, currentPointerPoint(event));
    });
    document.addEventListener("pointerup", function (event) {
      if (!captureDrag) return;
      event.preventDefault();
      void finalizeCapture(event);
    });
    document.getElementById("viewerContainer")?.addEventListener("scroll", function () {
      hideSelectionUi();
      if (captureModeActive) setCaptureMode(false);
    });
    window.addEventListener("resize", function () {
      if (!selectionState) return;
      scheduleSelectionUiUpdate();
    });
  }

  async function openDocument(config) {
    const app = window.PDFViewerApplication;
    if (!config.src) return;

    if (currentKey === [config.src, config.authHeader || "", config.mode].join("|")) {
      applyChrome(config);
      if (app.pdfViewer) {
        app.pdfViewer.scrollMode = mapScrollMode(config.scrollMode);
        app.pdfViewer.spreadMode = 0;
      }
      return;
    }

    currentKey = [config.src, config.authHeader || "", config.mode].join("|");
    sidebarState = {
      initialized: false,
      userClosed: false,
    };
    hideSelectionUi();
    applyChrome(config);

    if (app.pdfDocument) {
      await app.close();
    }

    app.eventBus.on("documentloaded", function onDocumentLoaded() {
      app.eventBus.off("documentloaded", onDocumentLoaded);
      applyDocumentDefaults(config);
    });

    const loadOpts = {
      url: config.src,
      httpHeaders: config.authHeader ? { Authorization: config.authHeader } : undefined,
      rangeChunkSize: RANGE_CHUNK_SIZE,
      disableRange: false,
      disableStream: true,
      disableAutoFetch: true,
      useWorkerFetch: false,
      cMapUrl: C_MAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    };

    await app.open(config.src, loadOpts);
  }

  async function applyConfig(nextConfig) {
    currentConfig = sanitizeConfig(nextConfig);
    applyChrome(currentConfig);
    await openDocument(currentConfig);
  }

  window.addEventListener(
    "message",
    async function (event) {
      if (event.origin !== ORIGIN) return;
      if (event.data?.channel !== CHANNEL) return;

      if (event.data.type === "config") {
        await applyConfig(event.data.config);
        return;
      }

      if (event.data.type === "navigate") {
        const page = Number(event.data.page);
        if (!Number.isFinite(page) || page < 1) return;
        currentConfig = { ...(currentConfig || sanitizeConfig({})), page: Math.round(page) };
        if (window.PDFViewerApplication?.pdfDocument) {
          window.PDFViewerApplication.page = Math.round(page);
        }
      }
    },
    false,
  );

  window.addEventListener(
    "load",
    function () {
      PDFViewerApplicationOptions.set("cMapUrl", C_MAP_URL);
      PDFViewerApplicationOptions.set("standardFontDataUrl", STANDARD_FONT_DATA_URL);
      PDFViewerApplication.initializedPromise.then(function () {
        bindEvents();
        post("ready");
      });
    },
    { once: true },
  );

  window.onerror = function () {
    const message = document.createElement("body");
    message.innerText = "An error occurred while loading the file. Please open it again.";
    document.documentElement.replaceChild(message, document.body);
  };
})();
