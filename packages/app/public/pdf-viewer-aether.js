"use strict";

(function () {
  const CHANNEL = "aether-pdf-viewer";
  const ORIGIN = window.location.origin;
  const C_MAP_URL = "/pdfjs-ref/web/cmaps/";
  const STANDARD_FONT_DATA_URL = "/pdfjs-ref/web/standard_fonts/";
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
      },
    };
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
      setTimeout(() => {
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
        withSidebarTrackingSuppressed(() => {
          app.pdfSidebar?.switchView?.(outlineSidebarView(), true);
          app.pdfSidebar?.open?.();
        });
      } else {
        withSidebarTrackingSuppressed(() => {
          app.pdfSidebar?.close?.();
        });
      }
    } else {
      withSidebarTrackingSuppressed(() => {
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

    const app = window.PDFViewerApplication;
    const eventBus = app.eventBus;

    eventBus.on("pagechanging", function (evt) {
      if (!evt?.pageNumber) return;
      post("pagechange", { page: evt.pageNumber });
    });

    eventBus.on("sidebarviewchanged", function (evt) {
      if (!currentConfig || currentConfig.mode !== "full") return;
      if (suppressSidebarTracking) return;
      rememberSidebarState(!!evt?.view);
    });

    eventBus.on("outlineloaded", function () {
      if (!currentConfig || currentConfig.mode !== "full") return;
      if (hasOutline() && !sidebarState.userClosed) {
        withSidebarTrackingSuppressed(() => {
          app.pdfSidebar?.switchView?.(outlineSidebarView(), true);
          app.pdfSidebar?.open?.();
        });
      } else {
        withSidebarTrackingSuppressed(() => {
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

    const swapLayout = document.getElementById("aetherSwapLayout");
    if (swapLayout) {
      swapLayout.addEventListener("click", function () {
        post("swaplayout");
      });
    }

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
      useWorkerFetch: false,
      cMapUrl: C_MAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    };

    // Align with the Ref_Project boot path: let the official viewer initialize
    // its UI state, then load the real document instance created from getDocument.
    await app.open(config.src);
    const doc = await window.pdfjsLib.getDocument(loadOpts).promise;
    if (doc?._pdfInfo) {
      doc._pdfInfo.fingerprints = [config.src];
    }
    await app.load(doc);
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
        return;
      }
    },
    false,
  );

  window.addEventListener(
    "load",
    function () {
      PDFViewerApplicationOptions.set("cMapUrl", C_MAP_URL);
      PDFViewerApplicationOptions.set("standardFontDataUrl", STANDARD_FONT_DATA_URL);
      PDFViewerApplication.initializedPromise.then(() => {
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
