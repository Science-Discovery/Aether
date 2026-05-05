import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const updater = process.env.OPENCODE_UPDATER_CHANNEL ?? "latest"
const rust = process.env.RUST_TARGET
const bridgeFilter = rust
  ? ["**/*", "!.venv/**", "!__pycache__/**", "!runtime/uv/**", `runtime/uv/uv-*-${rust}/**`]
  : ["**/*", "!.venv/**", "!__pycache__/**"]

const getBase = (): Configuration => ({
  artifactName: "aether-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      from: "../../.opencode/skills",
      to: ".aether/skills",
    },
    {
      from: "../../.opencode/agent",
      to: ".aether/agent",
    },
    {
      from: "../../.opencode/command",
      to: ".aether/command",
    },
    {
      from: "../../.opencode/themes",
      to: ".aether/themes",
    },
    {
      from: "../../Aether-wechat-bridge",
      to: "wechat-bridge",
      filter: bridgeFilter,
    },
    {
      from: "../../Update",
      to: "Update",
      filter: [
        "aether_darwin_installer.command",
        "aether_linux_installer.sh",
        "aether_windows_installer.bat",
      ],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    target: ["dmg"],
  },
  protocols: {
    name: "Aether Desktop",
    schemes: ["aether"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    target: ["nsis"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "com.aether.desktop.dev",
        productName: "Aether Desktop Dev",
        protocols: { name: "Aether Desktop Dev", schemes: ["aether"] },
        deb: { packageName: "aether-desktop-dev" },
        rpm: { packageName: "aether-desktop-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "com.aether.desktop.beta",
        productName: "Aether Desktop Beta",
        protocols: { name: "Aether Desktop Beta", schemes: ["aether"] },
        publish: { provider: "github", owner: "anomalyco", repo: "aether-beta", channel: "latest" },
        deb: { packageName: "aether-desktop-beta" },
        rpm: { packageName: "aether-desktop-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "com.aether.desktop",
        productName: "Aether Desktop",
        protocols: { name: "Aether Desktop", schemes: ["aether"] },
        publish: { provider: "github", owner: "Science-Discovery", repo: "Aether", channel: updater },
        deb: { packageName: "aether-desktop" },
        rpm: { packageName: "aether-desktop" },
      }
    }
  }
}

export default getConfig()
