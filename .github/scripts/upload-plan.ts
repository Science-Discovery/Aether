import { join } from "node:path"

export type Link = {
  url: string
  contentType: string
}

export type Upload = Link & {
  objectKey: string
}

export type PlatformEntry = {
  archive: Upload
  installer: Upload
}

export const webItems = {
  mac: { archive: "aether-darwin-arm64.dmg", installer: "update_darwin.command" },
  macIntel: { archive: "aether-darwin-x64.dmg", installer: "update_darwin.command" },
  windows: { archive: "aether-windows-x64.zip", installer: "update_windows.bat" },
  linux: { archive: "aether-linux-x64.zip", installer: "update_linux.sh" },
  linuxArm64: { archive: "aether-linux-arm64.zip", installer: "update_linux.sh" },
} satisfies Record<string, { archive: string; installer: string }>

export function isUpload(val: unknown): val is Upload {
  if (!val || typeof val !== "object") return false
  if (!("url" in val) || typeof val.url !== "string" || !val.url) return false
  if (!("contentType" in val) || typeof val.contentType !== "string") return false
  if (!("objectKey" in val) || typeof val.objectKey !== "string" || !val.objectKey) return false
  return true
}

export function planWebUploads(
  platforms: Record<string, PlatformEntry | undefined>,
  ver: string,
  assets: string,
  updates: string,
) {
  const links = new Map<string, Upload>()
  const tasks: Array<[string, Upload]> = []
  for (const [key, item] of Object.entries(webItems)) {
    const entry = platforms[key]
    if (!entry || !isUpload(entry.archive) || !isUpload(entry.installer)) {
      return { status: "error" as const, error: `Invalid web presign entry for ${key}` }
    }
    if (!entry.archive.objectKey.startsWith(`${ver}/`) || !entry.installer.objectKey.startsWith(`${ver}/`)) {
      return { status: "error" as const, error: `Unexpected web presign object keys for ${key}` }
    }
    links.set(entry.archive.objectKey, entry.archive)
    links.set(entry.installer.objectKey, entry.installer)
    tasks.push([join(assets, item.archive), entry.archive], [join(updates, item.installer), entry.installer])
  }
  return { status: "ok" as const, links, tasks }
}
