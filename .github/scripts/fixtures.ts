import { join } from "node:path"
import type { PlatformEntry } from "./upload-plan"

export const ver = "1.4.0"

export const platformKeys: Record<string, { archive: string; installer: string }> = {
  mac: { archive: `${ver}/aether-darwin-arm64.dmg`, installer: `${ver}/update_darwin.command` },
  macIntel: { archive: `${ver}/aether-darwin-x64.dmg`, installer: `${ver}/update_darwin_x64.command` },
  windows: { archive: `${ver}/aether-windows-x64.zip`, installer: `${ver}/update_windows.bat` },
  linux: { archive: `${ver}/aether-linux-x64.zip`, installer: `${ver}/update_linux.sh` },
  linuxArm64: { archive: `${ver}/aether-linux-arm64.zip`, installer: `${ver}/update_linux_arm64.sh` },
}

export function presignFixture(
  base: string,
  keys: Record<string, { archive: string; installer: string }> = platformKeys,
) {
  const platforms: Record<string, PlatformEntry> = {}
  for (const [key, val] of Object.entries(keys)) {
    platforms[key] = {
      archive: {
        url: `${base}/${val.archive}?sig=archive`,
        contentType: "application/octet-stream",
        objectKey: val.archive,
      },
      installer: {
        url: `${base}/${val.installer}?sig=installer`,
        contentType: "text/x-shellscript",
        objectKey: val.installer,
      },
    }
  }
  return platforms
}

export const betaItems = {
  mac: { archive: "dist/aether-darwin-arm64.dmg", installer: "Update/update_darwin.command" },
  macIntel: { archive: "dist/aether-darwin-x64.dmg", installer: "Update/update_darwin.command" },
  windows: { archive: "dist/aether-windows-x64.zip", installer: "Update/update_windows.bat" },
  linux: { archive: "dist/aether-linux-x64.zip", installer: "Update/update_linux.sh" },
  linuxArm64: { archive: "dist/aether-linux-arm64.zip", installer: "Update/update_linux.sh" },
}

export const betaPlatformKeys = Object.fromEntries(
  Object.entries(platformKeys).map(([key, val]) => [
    key,
    { archive: `beta/${val.archive}`, installer: `beta/${val.installer}` },
  ]),
)

export const betaDesktopNames = [
  "aether-desktop-mac-arm64.dmg",
  "aether-desktop-mac-arm64.dmg.blockmap",
  "aether-desktop-mac-arm64.zip",
  "aether-desktop-mac-arm64.zip.blockmap",
  "aether-desktop-mac-x64.dmg",
  "aether-desktop-mac-x64.dmg.blockmap",
  "aether-desktop-mac-x64.zip",
  "aether-desktop-mac-x64.zip.blockmap",
  "aether-desktop-win-x64.exe",
  "aether-desktop-win-x64.exe.blockmap",
  "aether-desktop-win-arm64.exe",
  "aether-desktop-win-arm64.exe.blockmap",
  "aether-desktop-linux-amd64.deb",
  "aether-desktop-linux-arm64.deb",
  "latest.yml",
  "latest-mac.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
]

export async function runScript(script: string, cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, script)], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}
