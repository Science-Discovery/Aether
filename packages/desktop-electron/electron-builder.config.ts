import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "aether-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*", "native/**"],
    },
    ...(process.platform === "darwin"
      ? [
          {
            from: "native/",
            to: "native/",
            filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
          },
          {
            from: "resources/icons",
            to: "icons",
            filter: ["dock.png"],
          },
        ]
      : []),
    {
      from: "../../.opencode/skills",
      to: ".aether/skills",
    },
    {
      from: "../../.opencode/agent",
      to: ".aether/agent",
      filter: ["**/*", "!triage.md", "!duplicate-pr.md"],
    },
    {
      from: "../../.opencode/command",
      to: ".aether/command",
      filter: ["**/*", "!issues.md", "!commit.md", "!changelog.md"],
    },
    {
      from: "../../.opencode/themes",
      to: ".aether/themes",
    },
    {
      from: "../../Update",
      to: "Update",
      filter: ["aether_darwin_installer.command", "aether_linux_installer.sh", "aether_windows_installer.bat"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    target: ["dmg", "zip"],
  },
  protocols: {
    name: "Aether Desktop",
    schemes: ["aether"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
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
        appId: "ai.aether.desktop.dev",
        productName: "Aether Desktop Dev",
        protocols: { name: "Aether Desktop Dev", schemes: ["aether"] },
        deb: { packageName: "aether-desktop-dev" },
        rpm: { packageName: "aether-desktop-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.aether.desktop.beta",
        productName: "Aether Desktop Beta",
        protocols: { name: "Aether Desktop Beta", schemes: ["aether"] },
        deb: { packageName: "aether-desktop-beta" },
        rpm: { packageName: "aether-desktop-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.aether.desktop",
        productName: "Aether Desktop",
        protocols: { name: "Aether Desktop", schemes: ["aether"] },
        publish: { provider: "generic", url: "https://aether.aiphys.cn/download/desktop/latest", channel: "latest" },
        deb: { packageName: "aether-desktop" },
        rpm: { packageName: "aether-desktop" },
      }
    }
  }
}

export default getConfig()
