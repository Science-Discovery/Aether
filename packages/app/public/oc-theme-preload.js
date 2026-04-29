;(function () {
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

    if (themeId === "oc-2") return

    var css = localStorage.getItem("opencode-theme-css-" + mode)
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
