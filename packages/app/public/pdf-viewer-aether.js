"use strict";

(function () {
  const CHANNEL = "aether-pdf-viewer";
  const IS_FILE_PROTOCOL = window.location.protocol === "file:";
  const ORIGIN = IS_FILE_PROTOCOL ? "*" : window.location.origin;
  const WORKER_SRC = "pdfjs-ref/build/pdf.worker.js";
  const C_MAP_URL = "pdfjs-ref/web/cmaps/";
  const STANDARD_FONT_DATA_URL = "pdfjs-ref/web/standard_fonts/";
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
    userClosed: true,
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
  let suppressBroadcastUntil = 0;

  function showViewerError(error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown PDF viewer error");
    const body = document.createElement("body");
    body.className = "aether-pdf-viewer-error";
    body.style.margin = "0";
    body.style.padding = "24px";
    body.style.background = "#1f1f23";
    body.style.color = "#f4f4f5";
    body.style.fontFamily = "ui-monospace, SFMono-Regular, Consolas, monospace";
    body.style.whiteSpace = "pre-wrap";
    body.textContent = `PDF viewer failed to load.\n\n${message}`;
    document.documentElement.replaceChild(body, document.body);
  }

  const OC2_THEME = {
    light:
      '--font-family-sans:"Inter", "Inter Fallback";' +
      '--background-base:#f8f8f8;' +
      '--background-strong:#fcfcfc;' +
      '--surface-base-hover:rgba(0, 0, 0, 0.059);' +
      '--surface-base-active:rgba(0, 0, 0, 0.051);' +
      '--surface-raised-base:rgba(0, 0, 0, 0.031);' +
      '--surface-raised-stronger-non-alpha:#ffffff;' +
      '--surface-interactive-base:#ecf3ff;' +
      '--input-base:#fcfcfc;' +
      '--text-base:#6f6f6f;' +
      '--text-strong:#171717;' +
      '--border-base:rgba(0, 0, 0, 0.162);' +
      '--border-selected:rgba(3, 76, 255, 0.99);' +
      '--border-weak-base:#e5e5e5;' +
      '--shadow-xs-border-base:0 0 0 1px var(--border-weak-base, rgba(17, 0, 0, 0.12)), 0 1px 2px -1px rgba(19, 16, 16, 0.04), 0 1px 2px 0 rgba(19, 16, 16, 0.06), 0 1px 3px 0 rgba(19, 16, 16, 0.08);' +
      '--shadow-xs-border-select:0 0 0 3px var(--border-weak-selected, rgba(1, 103, 255, 0.29)), 0 0 0 1px var(--border-selected, rgba(0, 74, 255, 0.99)), 0 1px 2px -1px rgba(19, 16, 16, 0.25), 0 1px 2px 0 rgba(19, 16, 16, 0.08), 0 1px 3px 0 rgba(19, 16, 16, 0.12);' +
      '--shadow-lg-border-base:0 0 0 1px var(--border-weak-base, rgba(0, 0, 0, 0.07)), 0 36px 80px 0 rgba(0, 0, 0, 0.03), 0 13.141px 29.201px 0 rgba(0, 0, 0, 0.04), 0 6.38px 14.177px 0 rgba(0, 0, 0, 0.05), 0 3.127px 6.95px 0 rgba(0, 0, 0, 0.06), 0 1.237px 2.748px 0 rgba(0, 0, 0, 0.09);',
    dark:
      '--font-family-sans:"Inter", "Inter Fallback";' +
      '--background-base:#161616;' +
      '--background-strong:#121212;' +
      '--surface-base-hover:rgba(255, 255, 255, 0.039);' +
      '--surface-base-active:rgba(255, 255, 255, 0.059);' +
      '--surface-raised-base:rgba(255, 255, 255, 0.059);' +
      '--surface-raised-stronger-non-alpha:#1c1c1c;' +
      '--surface-interactive-base:#091f52;' +
      '--input-base:#1c1c1c;' +
      '--text-base:rgba(255, 255, 255, 0.618);' +
      '--text-strong:rgba(255, 255, 255, 0.936);' +
      '--border-base:rgba(255, 255, 255, 0.195);' +
      '--border-selected:#9dbefe;' +
      '--border-weak-base:#282828;' +
      '--shadow-xs-border-base:0 0 0 1px var(--border-weak-base, rgba(17, 0, 0, 0.12)), 0 1px 2px -1px rgba(19, 16, 16, 0.04), 0 1px 2px 0 rgba(19, 16, 16, 0.06), 0 1px 3px 0 rgba(19, 16, 16, 0.08);' +
      '--shadow-xs-border-select:0 0 0 3px var(--border-weak-selected, rgba(1, 103, 255, 0.29)), 0 0 0 1px var(--border-selected, rgba(0, 74, 255, 0.99)), 0 1px 2px -1px rgba(19, 16, 16, 0.25), 0 1px 2px 0 rgba(19, 16, 16, 0.08), 0 1px 3px 0 rgba(19, 16, 16, 0.12);' +
      '--shadow-lg-border-base:0 0 0 1px var(--border-weak-base, rgba(0, 0, 0, 0.07)), 0 36px 80px 0 rgba(0, 0, 0, 0.03), 0 13.141px 29.201px 0 rgba(0, 0, 0, 0.04), 0 6.38px 14.177px 0 rgba(0, 0, 0, 0.05), 0 3.127px 6.95px 0 rgba(0, 0, 0, 0.06), 0 1.237px 2.748px 0 rgba(0, 0, 0, 0.09);',
  };

  function applyViewerTheme() {
    const prev = document.getElementById("aether-pdf-theme");
    if (prev) prev.remove();

    let theme = localStorage.getItem("opencode-theme-id") || "oc-2";
    if (theme === "oc-1") theme = "oc-2";
    if (theme !== "oc-2") return;

    const scheme = localStorage.getItem("opencode-color-scheme") || "system";
    const dark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    const mode = dark ? "dark" : "light";
    const style = document.createElement("style");
    style.id = "aether-pdf-theme";
    style.textContent =
      ":root{color-scheme:" + mode + ";--text-mix-blend-mode:" + (dark ? "plus-lighter" : "multiply") + ";" + OC2_THEME[mode] + "}";
    document.head.appendChild(style);
  }

  function applyTheme() {
    window.applyOCThemePreload?.();
    applyViewerTheme();
  }

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

  function hasReadingTools(config) {
    return !!(
      config &&
      config.features &&
      (config.features.quickReadingExit ||
        config.features.readingMode ||
        config.features.firstRead ||
        config.features.settings ||
        config.features.imageSelectionActions ||
        config.features.pdf2md)
    );
  }

  function getElementMarginWidth(element) {
    if (!element) return 0;
    const styles = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width + (parseFloat(styles.marginLeft) || 0) + (parseFloat(styles.marginRight) || 0);
  }

  function setElementHidden(element, hidden) {
    if (!element) return;
    element.hidden = !!hidden;
  }

  function syncQuickReadingToolbarOverflow() {
    const config = currentConfig;
    const pdf2mdPrimary = document.getElementById("aetherPdf2md");
    const pdf2mdSecondary = document.getElementById("aetherPdf2mdSecondary");
    const openReadingPrimary = document.getElementById("aetherOpenReadingMode");
    const openReadingSecondary = document.getElementById("aetherOpenReadingModeSecondary");
    const capturePrimary = document.getElementById("aetherCaptureRegion");
    const captureSecondary = document.getElementById("aetherCaptureRegionSecondary");
    const settingsPrimary = document.getElementById("aetherReadingSettings");
    const swapPrimary = document.getElementById("aetherSwapLayout");
    const firstReadSecondary = document.getElementById("aetherFirstRead");
    const settingsSecondary = document.getElementById("aetherReadingSettingsSecondary");
    const swapSecondary = document.getElementById("aetherSwapLayoutSecondary");

    if (!hasReadingTools(config)) {
      setElementHidden(pdf2mdPrimary, true);
      setElementHidden(pdf2mdSecondary, true);
      setElementHidden(openReadingSecondary, true);
      setElementHidden(captureSecondary, true);
      setElementHidden(firstReadSecondary, true);
      setElementHidden(settingsSecondary, true);
      setElementHidden(swapSecondary, true);
      return;
    }

    const toolbarContainer = document.getElementById("toolbarContainer");
    const toolbarLeft = document.getElementById("toolbarViewerLeft");
    const toolbarRight = document.getElementById("toolbarViewerRight");
    const toolbarMiddle = document.getElementById("toolbarViewerMiddle");

    if (!toolbarContainer || !toolbarLeft || !toolbarRight || !toolbarMiddle) {
      setElementHidden(pdf2mdPrimary, true);
      setElementHidden(pdf2mdSecondary, !(config.features && config.features.pdf2md));
      setElementHidden(openReadingSecondary, !(config.features && config.features.readingMode));
      setElementHidden(captureSecondary, !(config.features && config.features.imageSelectionActions));
      setElementHidden(firstReadSecondary, true);
      setElementHidden(settingsSecondary, true);
      setElementHidden(swapSecondary, true);
      return;
    }

    const compact = config.mode === "compact";
    const canShowSettings = !!(config.features && config.features.settings);

    setElementHidden(pdf2mdPrimary, true);
    setElementHidden(pdf2mdSecondary, !(config.features && config.features.pdf2md));
    setElementHidden(openReadingSecondary, !(compact && config.features && config.features.readingMode));
    setElementHidden(captureSecondary, !(compact && config.features && config.features.imageSelectionActions));
    setElementHidden(settingsPrimary, compact || !canShowSettings);
    setElementHidden(swapPrimary, compact || !(config.features && config.features.swapLayout));
    setElementHidden(firstReadSecondary, !(config.features && config.features.firstRead));
    setElementHidden(settingsSecondary, true);
    setElementHidden(swapSecondary, true);

    if (compact) return;

    const availableWidth =
      toolbarContainer.getBoundingClientRect().width -
      toolbarLeft.getBoundingClientRect().width -
      toolbarRight.getBoundingClientRect().width -
      24;

    const currentWidth = Array.from(toolbarMiddle.children).reduce(function (sum, child) {
      if (!(child instanceof HTMLElement) || child.hidden) return sum;
      return sum + getElementMarginWidth(child);
    }, 0);

    if (currentWidth <= availableWidth) return;

    setElementHidden(swapPrimary, true);
    setElementHidden(swapSecondary, false);

    const widthAfterSwap = Array.from(toolbarMiddle.children).reduce(function (sum, child) {
      if (!(child instanceof HTMLElement) || child.hidden) return sum;
      return sum + getElementMarginWidth(child);
    }, 0);

    if (widthAfterSwap <= availableWidth) return;

    if (canShowSettings) {
      setElementHidden(settingsPrimary, true);
      setElementHidden(settingsSecondary, false);
    }
  }

  function scheduleToolbarOverflowSync() {
    if (window.__aetherToolbarOverflowFrame) {
      cancelAnimationFrame(window.__aetherToolbarOverflowFrame);
    }
    window.__aetherToolbarOverflowFrame = requestAnimationFrame(function () {
      window.__aetherToolbarOverflowFrame = 0;
      syncQuickReadingToolbarOverflow();
    });
  }

  function sanitizeConfig(input) {
    const mode = input?.mode === "compact" ? "compact" : "full";
    const viewTheme =
      input?.viewTheme === "night" || input?.viewTheme === "eye" || input?.viewTheme === "day"
        ? input.viewTheme
        : input?.nightMode
          ? "night"
          : "day";
    return {
      src: typeof input?.src === "string" ? input.src : "",
      authHeader: typeof input?.authHeader === "string" && input.authHeader ? input.authHeader : undefined,
      mode,
      viewTheme,
      layoutSwapped: !!input?.layoutSwapped,
      page:
        typeof input?.page === "number" && Number.isFinite(input.page) && input.page > 0
          ? Math.round(input.page)
          : 1,
      location: typeof input?.location === "string" && input.location ? input.location : undefined,
      scale: typeof input?.scale === "string" && input.scale ? input.scale : DEFAULT_SCALE[mode],
      scrollMode:
        input?.scrollMode === "horizontal" || input?.scrollMode === "wrapped" ? input.scrollMode : "vertical",
      features: {
        pdf2md: !!input?.features?.pdf2md,
        readingMode: !!input?.features?.readingMode,
        quickReadingExit: !!input?.features?.quickReadingExit,
        firstRead: !!input?.features?.firstRead,
        settings: !!input?.features?.settings,
        textSelectionActions: !!input?.features?.textSelectionActions,
        imageSelectionActions: !!input?.features?.imageSelectionActions,
        swapLayout: !!input?.features?.swapLayout,
      },
    };
  }

  function selectionActionsEnabled() {
    return !!(
      currentConfig &&
      currentConfig.features &&
      currentConfig.features.textSelectionActions
    );
  }

  function imageSelectionActionsEnabled() {
    return !!(
      currentConfig &&
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
        startPage: selectionState.startPage,
        endPage: selectionState.endPage,
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

  function validRect(rect) {
    return !!rect && (rect.width || rect.height) && Number.isFinite(rect.top) && Number.isFinite(rect.left);
  }

  function anchorRect(selection, range) {
    const rects = Array.from(range.getClientRects()).filter(validRect);
    if (!rects.length) {
      const rect = range.getBoundingClientRect();
      return validRect(rect) ? rect : null;
    }
    const forward = selection.focusNode === range.endContainer && selection.focusOffset === range.endOffset;
    return forward ? rects[rects.length - 1] : rects[0];
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

    const rect = anchorRect(selection, range);
    if (!rect) return null;

    return {
      startPage: Math.min(startPageNumber, endPageNumber),
      endPage: Math.max(startPageNumber, endPageNumber),
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

    ensureSelectionUi();
    hideSelectionHint();
    selectionState = {
      kind: "text",
      startPage: context.startPage,
      endPage: context.endPage,
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

  function nextViewTheme(theme) {
    switch (theme) {
      case "night":
        return "eye";
      case "eye":
        return "day";
      default:
        return "night";
    }
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
    document.body.dataset.viewTheme = config.viewTheme;
    document.body.dataset.layoutSwapped = config.layoutSwapped ? "on" : "off";
    const outerContainer = document.getElementById("outerContainer");

    const pdf2md = document.getElementById("aetherPdf2md");
    if (pdf2md) {
      pdf2md.hidden = true;
      pdf2md.title = "Convert PDF to Markdown";
    }

    const pdf2mdSecondary = document.getElementById("aetherPdf2mdSecondary");
    if (pdf2mdSecondary) {
      pdf2mdSecondary.hidden = !config.features.pdf2md;
      pdf2mdSecondary.title = "PDF to md";
      pdf2mdSecondary.setAttribute("aria-label", pdf2mdSecondary.title);
    }

    const readingMode = document.getElementById("aetherOpenReadingMode");
    if (readingMode) {
      readingMode.hidden = !config.features.readingMode;
      readingMode.title = "Open reading view";
      readingMode.setAttribute("aria-label", readingMode.title);
    }

    const readingModeSecondary = document.getElementById("aetherOpenReadingModeSecondary");
    if (readingModeSecondary) {
      readingModeSecondary.hidden = config.mode !== "compact" || !config.features.readingMode;
      readingModeSecondary.title = "Open reading view";
      readingModeSecondary.setAttribute("aria-label", readingModeSecondary.title);
    }

    const exitQuickReading = document.getElementById("aetherExitQuickReading");
    if (exitQuickReading) {
      exitQuickReading.hidden = !config.features.quickReadingExit;
      exitQuickReading.title = "Exit reading view";
      exitQuickReading.setAttribute("aria-label", exitQuickReading.title);
    }

    const captureRegion = document.getElementById("aetherCaptureRegion");
    if (captureRegion) {
      captureRegion.hidden = !(config.mode === "full" && config.features.imageSelectionActions);
      captureRegion.title = captureModeActive ? "Exit capture mode" : "Capture region";
      captureRegion.setAttribute("aria-pressed", captureModeActive ? "true" : "false");
    }

    const captureRegionSecondary = document.getElementById("aetherCaptureRegionSecondary");
    if (captureRegionSecondary) {
      captureRegionSecondary.hidden = config.mode !== "compact" || !config.features.imageSelectionActions;
      captureRegionSecondary.title = captureModeActive ? "Exit capture mode" : "Capture region";
      captureRegionSecondary.setAttribute("aria-pressed", captureModeActive ? "true" : "false");
    }

    const firstRead = document.getElementById("aetherFirstRead");
    if (firstRead) {
      firstRead.hidden = !config.features.firstRead;
      firstRead.title = "AI pre-read";
      firstRead.setAttribute("aria-label", firstRead.title);
    }

    const readingSettings = document.getElementById("aetherReadingSettings");
    if (readingSettings) {
      readingSettings.hidden = !config.features.settings;
      readingSettings.title = "Reading view settings";
      readingSettings.setAttribute("aria-label", readingSettings.title);
    }

    const nightMode = document.getElementById("aetherNightMode");
    if (nightMode) {
      const labels = {
        day: "Switch to night mode",
        night: "Switch to eye comfort mode",
        eye: "Switch to day mode",
      };
      nightMode.title = labels[config.viewTheme] || labels.day;
      nightMode.classList.toggle("toggled", config.viewTheme !== "day");
      nightMode.setAttribute("aria-pressed", config.viewTheme === "day" ? "false" : "true");
      nightMode.dataset.theme = config.viewTheme;
    }

    const swapLayout = document.getElementById("aetherSwapLayout");
    if (swapLayout) {
      swapLayout.hidden = !config.features.swapLayout;
      swapLayout.title = config.layoutSwapped ? "Move PDF to the left" : "Move PDF to the right";
      swapLayout.setAttribute("aria-label", swapLayout.title);
      swapLayout.setAttribute("aria-pressed", config.layoutSwapped ? "true" : "false");
      swapLayout.dataset.direction = config.layoutSwapped ? "left" : "right";
    }

    const swapLayoutSecondary = document.getElementById("aetherSwapLayoutSecondary");
    if (swapLayoutSecondary) {
      swapLayoutSecondary.hidden = !config.features.swapLayout;
      swapLayoutSecondary.title = swapLayout?.title || "Swap layout";
      swapLayoutSecondary.setAttribute("aria-label", swapLayoutSecondary.title);
      swapLayoutSecondary.dataset.direction = swapLayout?.dataset.direction || "right";
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

    scheduleToolbarOverflowSync();
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

  function closeSidebar(app) {
    const outerContainer = document.getElementById("outerContainer");
    withSidebarTrackingSuppressed(function () {
      app?.pdfSidebar?.close?.();
    });
    outerContainer?.classList.remove("sidebarOpen", "sidebarMoving", "sidebarResizing");
  }

  function setSidebarView(app) {
    if (!app?.pdfSidebar) return;
    withSidebarTrackingSuppressed(function () {
      app.pdfSidebar.switchView?.(outlineSidebarView());
    });
  }

  function hasOutline() {
    const outline = document.getElementById("outlineView");
    return !!outline && outline.children.length > 0;
  }

  function locationPage(location) {
    if (typeof location !== "string" || !location) return;
    const match = /(?:^|&)page=(\d+)/.exec(location.replace(/^#/, ""));
    if (!match) return;
    const page = Number(match[1]);
    if (!Number.isFinite(page) || page < 1) return;
    return Math.round(page);
  }

  function applyLocation(location) {
    if (typeof location !== "string" || !location) return;
    suppressBroadcastUntil = Date.now() + 500;
    window.PDFViewerApplication?.pdfLinkService?.setHash?.(location);
  }

  function applyPosition(config) {
    const app = window.PDFViewerApplication;
    if (!app?.pdfViewer) return;
    const location = config.location;
    const page = locationPage(location);
    if (location && (page === undefined || page === config.page)) {
      applyLocation(location);
      return;
    }
    if (config.page > 1) {
      app.page = config.page;
    }
  }

  function applyDocumentDefaults(config) {
    const app = window.PDFViewerApplication;
    if (!app?.pdfViewer) return;

    app.pdfCursorTools?.switchTool?.(0);
    app.pdfViewer.scrollMode = mapScrollMode(config.scrollMode);
    app.pdfViewer.spreadMode = 0;
    app.pdfViewer.currentScaleValue = config.scale;
    setSidebarView(app);

    if (config.mode === "full") {
      closeSidebar(app);
    } else {
      closeSidebar(app);
    }

    applyPosition(config);
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    ensureSelectionUi();

    const app = window.PDFViewerApplication;
    const eventBus = app.eventBus;

    eventBus.on("pagechanging", function (evt) {
      if (!evt?.pageNumber) return;
      if (Date.now() < suppressBroadcastUntil) return;
      hideSelectionUi();
      post("pagechange", { page: evt.pageNumber });
    });

    eventBus.on("updateviewarea", function (evt) {
      if (Date.now() < suppressBroadcastUntil) return;
      const location = evt?.location?.pdfOpenParams;
      if (typeof location !== "string" || !location) return;
      post("locationchange", { location: location.startsWith("#") ? location.slice(1) : location });
    });

    eventBus.on("pagesloaded", function (evt) {
      const totalPages = Number(evt?.pagesCount || window.PDFViewerApplication?.pdfDocument?.numPages || 0);
      if (!Number.isFinite(totalPages) || totalPages <= 0) return;
      post("documentinfo", { totalPages });
      if (currentConfig) {
        requestAnimationFrame(function () {
          if (!currentConfig) return;
          applyPosition(currentConfig);
        });
      }
    });

    eventBus.on("sidebarviewchanged", function (evt) {
      if (!currentConfig || currentConfig.mode !== "full") return;
      if (suppressSidebarTracking) return;
      rememberSidebarState(!!evt?.view);
    });

    eventBus.on("outlineloaded", function () {
      if (!currentConfig || currentConfig.mode !== "full") return;
      setSidebarView(app);
      closeSidebar(app);
    });

    const pdf2md = document.getElementById("aetherPdf2md");
    if (pdf2md) {
      pdf2md.addEventListener("click", function () {
        post("pdf2md");
      });
    }

    const pdf2mdSecondary = document.getElementById("aetherPdf2mdSecondary");
    if (pdf2mdSecondary) {
      pdf2mdSecondary.addEventListener("click", function () {
        post("pdf2md");
        window.PDFViewerApplication?.secondaryToolbar?.close?.();
      });
    }

    const readingMode = document.getElementById("aetherOpenReadingMode");
    if (readingMode) {
      readingMode.addEventListener("click", function () {
        post("openreadingmode");
      });
    }

    const readingModeSecondary = document.getElementById("aetherOpenReadingModeSecondary");
    if (readingModeSecondary) {
      readingModeSecondary.addEventListener("click", function () {
        post("openreadingmode");
        window.PDFViewerApplication?.secondaryToolbar?.close?.();
      });
    }

    const nightMode = document.getElementById("aetherNightMode");
    if (nightMode) {
      nightMode.addEventListener("click", function () {
        currentConfig = {
          ...(currentConfig || sanitizeConfig({})),
          viewTheme: nextViewTheme(currentConfig?.viewTheme),
        };
        applyChrome(currentConfig);
        post("viewtheme", { theme: currentConfig.viewTheme });
      });
    }

    const captureRegion = document.getElementById("aetherCaptureRegion");
    if (captureRegion) {
      captureRegion.addEventListener("click", function () {
        setCaptureMode(!captureModeActive);
      });
    }

    const captureRegionSecondary = document.getElementById("aetherCaptureRegionSecondary");
    if (captureRegionSecondary) {
      captureRegionSecondary.addEventListener("click", function () {
        setCaptureMode(!captureModeActive);
        window.PDFViewerApplication?.secondaryToolbar?.close?.();
      });
    }

    const firstRead = document.getElementById("aetherFirstRead");
    if (firstRead) {
      firstRead.addEventListener("click", function () {
        post("startfirstread");
        window.PDFViewerApplication?.secondaryToolbar?.close?.();
      });
    }

    const exitQuickReading = document.getElementById("aetherExitQuickReading");
    if (exitQuickReading) {
      exitQuickReading.addEventListener("click", function () {
        post("exitquickreading");
      });
    }

    const readingSettings = document.getElementById("aetherReadingSettings");
    if (readingSettings) {
      readingSettings.addEventListener("click", function () {
        post("opensettings");
      });
    }

    const readingSettingsSecondary = document.getElementById("aetherReadingSettingsSecondary");
    if (readingSettingsSecondary) {
      readingSettingsSecondary.addEventListener("click", function () {
        post("opensettings");
        window.PDFViewerApplication?.secondaryToolbar?.close?.();
      });
    }

    const swapLayout = document.getElementById("aetherSwapLayout");
    if (swapLayout) {
      swapLayout.addEventListener("click", function () {
        post("swaplayout");
      });
    }

    const swapLayoutSecondary = document.getElementById("aetherSwapLayoutSecondary");
    if (swapLayoutSecondary) {
      swapLayoutSecondary.addEventListener("click", function () {
        post("swaplayout");
        window.PDFViewerApplication?.secondaryToolbar?.close?.();
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
      scheduleToolbarOverflowSync();
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
      userClosed: true,
    };
    hideSelectionUi();
    applyChrome(config);
    closeSidebar(app);

    if (app.pdfDocument) {
      await app.close();
      closeSidebar(app);
    }

    app.eventBus.on("documentloaded", function onDocumentLoaded() {
      app.eventBus.off("documentloaded", onDocumentLoaded);
      applyDocumentDefaults(config);
      scheduleToolbarOverflowSync();
    });

    const loadOpts = {
      url: config.src,
      httpHeaders: config.authHeader ? { Authorization: config.authHeader } : undefined,
      rangeChunkSize: RANGE_CHUNK_SIZE,
      useWorkerFetch: false,
      cMapUrl: C_MAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    };

    const doc = await window.pdfjsLib.getDocument(loadOpts).promise;
    if (doc?._pdfInfo) {
      doc._pdfInfo.fingerprints = [config.src];
    }
    await app.load(doc);
  }

  async function applyConfig(nextConfig) {
    currentConfig = sanitizeConfig(nextConfig);
    applyChrome(currentConfig);
    try {
      await openDocument(currentConfig);
    } catch (error) {
      console.error("[aether-pdf-viewer] failed to open document", {
        config: currentConfig,
        error,
      });
      showViewerError(error);
      throw error;
    }
  }

  window.addEventListener(
    "message",
    async function (event) {
      if (event.data?.channel !== CHANNEL) return;
      if (!IS_FILE_PROTOCOL && event.origin !== ORIGIN) return;

      if (event.data.type === "config") {
        await applyConfig(event.data.config);
        return;
      }

      if (event.data.type === "navigate") {
        const page = Number(event.data.page);
        if (!Number.isFinite(page) || page < 1) return;
        currentConfig = { ...(currentConfig || sanitizeConfig({})), page: Math.round(page) };
        if (window.PDFViewerApplication?.pdfDocument) {
          suppressBroadcastUntil = Date.now() + 500;
          window.PDFViewerApplication.page = Math.round(page);
        }
        return;
      }

      if (event.data.type === "location") {
        const location = typeof event.data.location === "string" ? event.data.location : "";
        if (!location) return;
        currentConfig = { ...(currentConfig || sanitizeConfig({})), location };
        applyLocation(location);
        return;
      }

      if (event.data.type === "themechange") {
        applyTheme();
      }
    },
    false,
  );

  window.addEventListener(
    "load",
    function () {
      applyTheme();
      PDFViewerApplicationOptions.set("sidebarViewOnLoad", 0);
      PDFViewerApplicationOptions.set("viewOnLoad", 1);
      PDFViewerApplicationOptions.set("workerSrc", WORKER_SRC);
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
    showViewerError("An error occurred while loading the file. Please open it again.");
  };

  window.onunhandledrejection = function (event) {
    showViewerError(event.reason);
  };
})();
