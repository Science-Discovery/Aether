;(function () {
  var oc2 = {
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
  }

  function themeCSS(themeId, mode) {
    if (themeId === "oc-2") return oc2[mode]
    return localStorage.getItem("opencode-theme-css-" + mode)
  }

  function applyOCThemePreload() {
    var key = "opencode-theme-id"
    var themeId = localStorage.getItem(key) || "oc-2"
    var existing = document.getElementById("oc-theme-preload")

    if (existing) {
      existing.remove()
    }

    if (themeId === "oc-1") {
      themeId = "oc-2"
      localStorage.setItem(key, themeId)
      localStorage.removeItem("opencode-theme-css-light")
      localStorage.removeItem("opencode-theme-css-dark")
    }

    var scheme = localStorage.getItem("opencode-color-scheme") || "system"
    var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    var mode = isDark ? "dark" : "light"

    document.documentElement.dataset.theme = themeId
    document.documentElement.dataset.colorScheme = mode

    var css = themeCSS(themeId, mode)
    if (css) {
      var style = document.createElement("style")
      style.id = "oc-theme-preload"
      style.textContent =
        ":root{color-scheme:" +
        mode +
        ";--text-mix-blend-mode:" +
        (isDark ? "plus-lighter" : "multiply") +
        ";" +
        css +
        "}"
      document.head.appendChild(style)
    }
  }

  window.applyOCThemePreload = applyOCThemePreload
  applyOCThemePreload()
})()
