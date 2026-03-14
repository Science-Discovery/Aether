import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "openresearch-${os}-${arch}.${ext}",
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
      to: ".opencode/skills",
    },
    {
      from: "../../.opencode/agent",
      to: ".opencode/agent",
    },
    {
      from: "../../.opencode/command",
      to: ".opencode/command",
    },
    {
      from: "../../.opencode/themes",
      to: ".opencode/themes",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    target: ["dir"],
  },
  protocols: {
    name: "OpenResearch",
    schemes: ["openresearch"],
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
        appId: "com.openresearch.desktop.dev",
        productName: "OpenResearch Dev",
        rpm: { packageName: "openresearch-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "com.openresearch.desktop.beta",
        productName: "OpenResearch Beta",
        protocols: { name: "OpenResearch Beta", schemes: ["openresearch"] },
        publish: { provider: "github", owner: "anomalyco", repo: "openresearch-beta", channel: "latest" },
        rpm: { packageName: "openresearch-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "com.openresearch.desktop",
        productName: "OpenResearch",
        protocols: { name: "OpenResearch", schemes: ["openresearch"] },
        publish: { provider: "github", owner: "anomalyco", repo: "openresearch", channel: "latest" },
        rpm: { packageName: "openresearch" },
      }
    }
  }
}

export default getConfig()
