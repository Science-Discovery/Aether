import { expect, test } from "bun:test"
import { join } from "node:path"
import { planWebUploads, webItems } from "./upload-plan"
import { platformKeys, presignFixture, ver } from "./fixtures"

function planOrThrow(platforms: Parameters<typeof planWebUploads>[0]) {
  const planned = planWebUploads(platforms, ver, "assets", "Update")
  if (planned.status !== "ok") throw new Error(planned.error)
  return planned
}

test("plan keeps every platform on its own presigned links", () => {
  const platforms = presignFixture("https://oss.example")
  const planned = planOrThrow(platforms)
  expect(planned.links.size).toBe(10)
  expect(new Set(planned.links.keys()).size).toBe(10)
  expect(planned.tasks.length).toBe(10)
  for (const [key, item] of Object.entries(webItems)) {
    const entry = platforms[key]!
    const archive = planned.tasks.find((task) => task[1] === entry.archive)
    const installer = planned.tasks.find((task) => task[1] === entry.installer)
    expect(archive?.[0]).toBe(join("assets", item.archive))
    expect(installer?.[0]).toBe(join("Update", item.installer))
  }
  expect(planned.links.get(`${ver}/update_darwin_x64.command`)?.url).toBe(platforms.macIntel!.installer.url)
  expect(planned.links.get(`${ver}/update_linux_arm64.sh`)?.url).toBe(platforms.linuxArm64!.installer.url)
})

test("distinct objectKeys with colliding basenames never collapse", () => {
  const platforms = presignFixture("https://oss.example", {
    mac: { archive: `${ver}/mac/aether-darwin-arm64.dmg`, installer: `${ver}/mac/update_darwin.command` },
    macIntel: { archive: `${ver}/macIntel/aether-darwin-x64.dmg`, installer: `${ver}/macIntel/update_darwin.command` },
    windows: { archive: `${ver}/windows/aether-windows-x64.zip`, installer: `${ver}/windows/update_windows.bat` },
    linux: { archive: `${ver}/linux/aether-linux-x64.zip`, installer: `${ver}/linux/update_linux.sh` },
    linuxArm64: { archive: `${ver}/linuxArm64/aether-linux-arm64.zip`, installer: `${ver}/linuxArm64/update_linux.sh` },
  })
  const planned = planOrThrow(platforms)
  expect(planned.links.size).toBe(10)
  const darwinKeys = [...planned.links.keys()].filter((key) => key.endsWith("update_darwin.command"))
  expect(darwinKeys).toEqual([`${ver}/mac/update_darwin.command`, `${ver}/macIntel/update_darwin.command`])
  expect(planned.links.get(`${ver}/macIntel/update_darwin.command`)).toBe(platforms.macIntel!.installer)
  expect(planned.links.get(`${ver}/mac/update_darwin.command`)).toBe(platforms.mac!.installer)
})

test("missing platform entry fails planning", () => {
  const platforms = presignFixture("https://oss.example")
  delete platforms.macIntel
  const planned = planWebUploads(platforms, ver, "assets", "Update")
  expect(planned.status).toBe("error")
  if (planned.status === "error") expect(planned.error).toContain("macIntel")
})

test("malformed presign entry fails planning", () => {
  const platforms = presignFixture("https://oss.example")
  platforms.mac.installer.objectKey = ""
  const planned = planWebUploads(platforms, ver, "assets", "Update")
  expect(planned.status).toBe("error")
  if (planned.status === "error") expect(planned.error).toContain("mac")
})

test("object keys outside the version prefix fail planning", () => {
  const platforms = presignFixture("https://oss.example")
  platforms.linuxArm64.installer.objectKey = `other/${ver}/update_linux_arm64.sh`
  const planned = planWebUploads(platforms, ver, "assets", "Update")
  expect(planned.status).toBe("error")
  if (planned.status === "error") expect(planned.error).toContain("linuxArm64")
})
