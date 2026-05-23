import { describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "child_process"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../..")
const update = path.join(root, "Update")
const linux =
  process.platform === "linux" &&
  spawnSync("bash", ["-lc", "type mapfile >/dev/null 2>&1"], { encoding: "utf8" }).status === 0
    ? test
    : test.skip
const darwin = test.skip // TODO: Need to be re-enabled and fixed on CI
const windows = process.platform === "win32" ? test : test.skip

function run(cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>) {
  const out = spawnSync(cmd, args, { cwd, env, encoding: "utf8" })
  if (out.status === 0) return `${out.stdout}${out.stderr}`
  throw new Error(`${cmd} ${args.join(" ")} failed\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`)
}

function fail(cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>) {
  return spawnSync(cmd, args, { cwd, env, encoding: "utf8" })
}

function lines(text: string) {
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function pick(text: string, prefix: string) {
  return lines(text)
    .find((x) => x.startsWith(prefix))
    ?.slice(prefix.length)
    .trim()
}

async function cp(src: string, dst: string) {
  await fs.copyFile(src, dst)
  await fs.chmod(dst, 0o755)
}

async function app(dir: string, os: "linux" | "darwin") {
  await fs.mkdir(dir, { recursive: true })
  const bin = path.join(dir, "aether")
  const cmd = path.join(dir, os === "linux" ? "Aether.sh" : "Aether.command")
  await Bun.write(bin, "#!/usr/bin/env bash\nexit 0\n")
  await Bun.write(cmd, "#!/usr/bin/env bash\nexit 0\n")
  await fs.chmod(bin, 0o755)
  await fs.chmod(cmd, 0o755)
}

async function longApp(dir: string, os: "linux" | "darwin") {
  await app(dir, os)
  const cmd = path.join(dir, os === "linux" ? "Aether.sh" : "Aether.command")
  await Bun.write(cmd, "#!/usr/bin/env bash\nwhile true; do sleep 1; done\n")
  await fs.chmod(cmd, 0o755)
}

async function winApp(dir: string) {
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "aether.exe"), "stub")
  await Bun.write(path.join(dir, "Aether.vbs"), 'Set sh=CreateObject("WScript.Shell")\nWScript.Quit 0\n')
}

function alive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number | undefined) {
  for (let i = 0; i < 30; i++) {
    if (!alive(pid)) return true
    await Bun.sleep(250)
  }
  return !alive(pid)
}

function cleanup(pid: number | undefined) {
  if (!pid) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

async function ver(dir: string, v: string) {
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, ".aether_web_version"), `${v}\n`)
}

function zip(src: string, out: string) {
  run("zip", ["-qr", out, "."], src, process.env)
}

function winZip(src: string, out: string) {
  run(
    "powershell",
    ["-NoProfile", "-Command", "Compress-Archive -Path (Join-Path $env:SRC '*') -DestinationPath $env:OUT -Force"],
    root,
    { ...process.env, SRC: src, OUT: out },
  )
}

function dmg(src: string, out: string) {
  run(
    "hdiutil",
    ["create", "-quiet", "-ov", "-fs", "HFS+", "-srcfolder", src, "-format", "UDZO", out],
    root,
    process.env,
  )
}

function mac() {
  return process.arch === "arm64" ? "arm64" : "x64"
}

async function dirs(root: string) {
  return (await fs.readdir(root)).filter((x) => x.startsWith("aether_")).sort()
}

function winLinks() {
  return lines(
    run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "$w=New-Object -ComObject WScript.Shell; $desk=[Environment]::GetFolderPath('DesktopDirectory'); if(-not $desk){ $desk=$w.SpecialFolders.Item('Desktop') }; $menu=[Environment]::GetFolderPath('Programs'); if(-not $menu){ $menu=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs' }; $desk2=[Environment]::GetFolderPath('CommonDesktopDirectory'); $menu2=[Environment]::GetFolderPath('CommonPrograms'); @($desk,$menu,$desk2,$menu2) | Where-Object { $_ } | Select-Object -Unique | ForEach-Object { Join-Path $_ 'Aether.lnk' }",
      ],
      root,
      process.env,
    ),
  )
}

async function stash(paths: string[]) {
  return Promise.all(
    paths.map(async (file) => ({
      file,
      data: (await Bun.file(file).exists()) ? Buffer.from(await Bun.file(file).arrayBuffer()) : null,
    })),
  )
}

async function restore(items: Awaited<ReturnType<typeof stash>>) {
  for (const item of items) {
    if (item.data) {
      await fs.mkdir(path.dirname(item.file), { recursive: true }).catch((e: any) => {
        if (e.code !== "EEXIST") throw e
      })
      await fs.writeFile(item.file, item.data)
      continue
    }
    await fs.rm(item.file, { force: true }).catch(() => undefined)
  }
}

function winTarget(file: string) {
  return run(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($env:LNK); [Console]::Write($s.TargetPath)",
    ],
    root,
    { ...process.env, LNK: file },
  ).trim()
}

describe("web update scripts", () => {
  linux(
    "linux script mirrors with timestamp fallback and prunes mirror dirs",
    async () => {
      await using tmp = await tmpdir()
      const home = path.join(tmp.path, "home")
      const work = path.join(tmp.path, "aether")
      const dl = path.join(work, "downloads")
      const live = path.join(tmp.path, "live")
      const cur = path.join(live, "current")
      const src = path.join(tmp.path, "src-linux")
      const out = path.join(dl, "aether-linux-x64-1.2.7.zip")
      const script = path.join(dl, "update_linux.sh")

      await fs.mkdir(dl, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(live, { recursive: true })
      await fs.mkdir(cur, { recursive: true })
      await app(src, "linux")
      zip(src, out)
      await cp(path.join(update, "update_linux.sh"), script)
      for (const v of ["1.2.0", "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.2.7"]) {
        await ver(path.join(live, `aether_${v}`), v)
      }

      const log = run("bash", [script, "1.2.7"], dl, {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AETHER_CURRENT_DIR: cur,
      })

      expect(await Bun.file(path.join(work, "aether_1.2.7", "Aether.sh")).exists()).toBe(true)
      const list = await dirs(live)
      expect(list.length).toBe(8)
      expect(list.some((x) => /^aether_1\.2\.7_\d{12}$/.test(x))).toBe(true)
      expect(list.includes("aether_1.2.0")).toBe(true)
    },
    { timeout: 30000 },
  )

  linux(
    "linux script skips mirror when current app already runs in WorkDir",
    async () => {
      await using tmp = await tmpdir()
      const home = path.join(tmp.path, "home")
      const work = path.join(tmp.path, "aether")
      const dl = path.join(work, "downloads")
      const cur = path.join(work, "aether_1.2.6")
      const src = path.join(tmp.path, "src-linux")
      const out = path.join(dl, "aether-linux-x64-1.2.7.zip")
      const script = path.join(dl, "update_linux.sh")

      await fs.mkdir(dl, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await ver(cur, "1.2.6")
      await app(src, "linux")
      zip(src, out)
      await cp(path.join(update, "update_linux.sh"), script)

      const log = run("bash", [script, "1.2.7"], dl, {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AETHER_CURRENT_DIR: cur,
      })

      expect(log).toContain("skipped mirror")
      expect(await Bun.file(path.join(work, "aether_1.2.7", "Aether.sh")).exists()).toBe(true)
      expect((await dirs(work)).some((x) => /^aether_1\.2\.7_\d{12}$/.test(x))).toBe(false)
      const desktop = await Bun.file(path.join(home, ".local", "share", "applications", "aether.desktop")).text()
      expect(desktop).toContain("Type=Application")
      expect(desktop).toContain("Name=Aether")
      expect(desktop).toContain(path.join(work, "aether_1.2.7", "Aether.sh"))
    },
    { timeout: 30000 },
  )

  linux(
    "linux script stops old runtime before restart",
    async () => {
      await using tmp = await tmpdir()
      const home = path.join(tmp.path, "home")
      const work = path.join(tmp.path, "aether")
      const dl = path.join(work, "downloads")
      const old = path.join(work, "aether_1.2.6")
      const src = path.join(tmp.path, "src-linux")
      const out = path.join(dl, "aether-linux-x64-1.2.7.zip")
      const script = path.join(dl, "update_linux.sh")

      await fs.mkdir(dl, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await ver(old, "1.2.6")
      await longApp(old, "linux")
      await app(src, "linux")
      zip(src, out)
      await cp(path.join(update, "update_linux.sh"), script)

      const child = spawn(path.join(old, "Aether.sh"), [], { stdio: "ignore" })
      try {
        expect(alive(child.pid)).toBe(true)
        run("bash", [script, "1.2.7", "--restart"], dl, {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AETHER_CURRENT_DIR: old,
        })
        expect(await waitDead(child.pid)).toBe(true)
      } finally {
        cleanup(child.pid)
      }
    },
    { timeout: 30000 },
  )

  linux(
    "linux script writes result file for failed mirror-only retry",
    async () => {
      await using tmp = await tmpdir()
      const home = path.join(tmp.path, "home")
      const work = path.join(tmp.path, "aether")
      const dl = path.join(work, "downloads")
      const script = path.join(dl, "update_linux.sh")
      const result = path.join(tmp.path, "mirror-result.env")

      await fs.mkdir(dl, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await cp(path.join(update, "update_linux.sh"), script)

      const out = fail("bash", [script, "1.2.7"], dl, {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AETHER_CURRENT_DIR: path.join(tmp.path, "live", "current"),
        AETHER_MIRROR_ONLY: "1",
        AETHER_UPDATE_RESULT: result,
      })

      expect(out.status).not.toBe(0)
      const text = await Bun.file(result).text()
      expect(text).toContain("status=failed")
      expect(text).toContain("action=recover")
      expect(text).toContain("Installed version directory not found for mirror retry")
    },
    { timeout: 30000 },
  )

  darwin(
    "darwin script mirrors with timestamp fallback and prunes mirror dirs",
    async () => {
      await using tmp = await tmpdir()
      const home = path.join(tmp.path, "home")
      const work = path.join(tmp.path, "aether")
      const dl = path.join(work, "downloads")
      const live = path.join(tmp.path, "live")
      const cur = path.join(live, "current")
      const src = path.join(tmp.path, "src-darwin")
      const out = path.join(dl, `aether-darwin-${mac()}-1.2.7.dmg`)
      const script = path.join(dl, "update_darwin.command")

      await fs.mkdir(dl, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(live, { recursive: true })
      await fs.mkdir(cur, { recursive: true })
      await app(src, "darwin")
      dmg(src, out)
      await cp(path.join(update, "update_darwin.command"), script)
      for (const v of ["1.2.0", "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.2.7"]) {
        await ver(path.join(live, `aether_${v}`), v)
      }

      const log = run("bash", [script, "1.2.7"], dl, {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AETHER_CURRENT_DIR: cur,
      })

      expect(await Bun.file(path.join(work, "aether_1.2.7", "Aether.command")).exists()).toBe(true)
      const list = await dirs(live)
      expect(list.length).toBe(8)
      expect(list.some((x) => /^aether_1\.2\.7_\d{12}$/.test(x))).toBe(true)
      expect(list.includes("aether_1.2.0")).toBe(true)
    },
    { timeout: 30000 },
  )

  darwin(
    "darwin script skips mirror when current app already runs in WorkDir",
    async () => {
      await using tmp = await tmpdir()
      const home = path.join(tmp.path, "home")
      const work = path.join(tmp.path, "aether")
      const dl = path.join(work, "downloads")
      const cur = path.join(work, "aether_1.2.6")
      const src = path.join(tmp.path, "src-darwin")
      const out = path.join(dl, `aether-darwin-${mac()}-1.2.7.dmg`)
      const script = path.join(dl, "update_darwin.command")

      await fs.mkdir(dl, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await ver(cur, "1.2.6")
      await app(src, "darwin")
      dmg(src, out)
      await cp(path.join(update, "update_darwin.command"), script)

      const log = run("bash", [script, "1.2.7"], dl, {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AETHER_CURRENT_DIR: cur,
      })

      expect(log).toContain("已跳过 mirror")
      const file = (await Bun.file(path.join("/Applications", "Aether.app", "Contents", "MacOS", "Aether")).exists())
        ? path.join("/Applications", "Aether.app", "Contents", "MacOS", "Aether")
        : path.join(home, "Applications", "Aether.app", "Contents", "MacOS", "Aether")
      const bin = await Bun.file(file).text()
      expect(bin).toContain(path.join(work, "aether_1.2.7", "Aether.command"))
    },
    { timeout: 30000 },
  )

  darwin(
    "darwin script stops old runtime before restart",
    async () => {
      await using tmp = await tmpdir()
      const home = path.join(tmp.path, "home")
      const work = path.join(tmp.path, "aether")
      const dl = path.join(work, "downloads")
      const old = path.join(work, "aether_1.2.6")
      const src = path.join(tmp.path, "src-darwin")
      const out = path.join(dl, `aether-darwin-${mac()}-1.2.7.dmg`)
      const script = path.join(dl, "update_darwin.command")

      await fs.mkdir(dl, { recursive: true })
      await fs.mkdir(home, { recursive: true })
      await ver(old, "1.2.6")
      await longApp(old, "darwin")
      await app(src, "darwin")
      dmg(src, out)
      await cp(path.join(update, "update_darwin.command"), script)

      const child = spawn(path.join(old, "Aether.command"), [], { stdio: "ignore" })
      try {
        expect(alive(child.pid)).toBe(true)
        run("bash", [script, "1.2.7", "--restart"], dl, {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AETHER_CURRENT_DIR: old,
        })
        expect(await waitDead(child.pid)).toBe(true)
      } finally {
        cleanup(child.pid)
      }
    },
    { timeout: 30000 },
  )

  windows(
    "windows script mirrors with timestamp fallback and prunes mirror dirs",
    async () => {
      const links = winLinks()
      const prev = await stash(links)
      try {
        await using tmp = await tmpdir()
        const work = path.join(tmp.path, "aether")
        const dl = path.join(work, "downloads")
        const live = path.join(tmp.path, "live")
        const cur = path.join(live, "current")
        const src = path.join(tmp.path, "src-windows")
        const out = path.join(dl, "aether-windows-x64-1.2.7.zip")
        const script = path.join(dl, "update_windows.bat")

        await fs.mkdir(dl, { recursive: true })
        await fs.mkdir(live, { recursive: true })
        await fs.mkdir(cur, { recursive: true })
        await winApp(src)
        winZip(src, out)
        await fs.copyFile(path.join(update, "update_windows.bat"), script)
        for (const v of ["1.2.0", "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.2.7"]) {
          await ver(path.join(live, `aether_${v}`), v)
        }

        const log = run("cmd", ["/c", script, "1.2.7"], dl, {
          ...process.env,
          AETHER_CURRENT_DIR: cur,
        })

        expect(await Bun.file(path.join(work, "aether_1.2.7", "Aether.vbs")).exists()).toBe(true)
        const list = await dirs(live)
        expect(list.length).toBe(8)
        expect(list.some((x) => /^aether_1\.2\.7_\d{12}$/.test(x))).toBe(true)
        expect(list.includes("aether_1.2.0")).toBe(true)
        const launch = pick(log, "Launch entry:")
        expect(launch).toBeTruthy()
        expect(winTarget(launch!)).toContain("aether_1.2.7_")
      } finally {
        await restore(prev)
      }
    },
    { timeout: 30000 },
  )

  windows(
    "windows script skips mirror when current app already runs in WorkDir",
    async () => {
      const links = winLinks()
      const prev = await stash(links)
      try {
        await using tmp = await tmpdir()
        const work = path.join(tmp.path, "aether")
        const dl = path.join(work, "downloads")
        const cur = path.join(work, "aether_1.2.6")
        const src = path.join(tmp.path, "src-windows")
        const out = path.join(dl, "aether-windows-x64-1.2.7.zip")
        const script = path.join(dl, "update_windows.bat")

        await fs.mkdir(dl, { recursive: true })
        await ver(cur, "1.2.6")
        await winApp(src)
        winZip(src, out)
        await fs.copyFile(path.join(update, "update_windows.bat"), script)

        const log = run("cmd", ["/c", script, "1.2.7"], dl, {
          ...process.env,
          AETHER_CURRENT_DIR: cur,
        })

        expect(log).toContain("skipped mirror")
        expect(await Bun.file(path.join(work, "aether_1.2.7", "Aether.vbs")).exists()).toBe(true)
        expect((await dirs(work)).some((x) => /^aether_1\.2\.7_\d{12}$/.test(x))).toBe(false)
        const launch = pick(log, "Launch entry:")
        expect(launch).toBeTruthy()
        expect(winTarget(launch!)).toContain(path.join(work, "aether_1.2.7", "Aether.vbs"))
      } finally {
        await restore(prev)
      }
    },
    { timeout: 30000 },
  )

  windows(
    "windows script debug log handles cmd metacharacters",
    async () => {
      const links = winLinks()
      const prev = await stash(links)
      try {
        await using tmp = await tmpdir()
        const work = path.join(tmp.path, "aether")
        const dl = path.join(work, "downloads")
        const cur = path.join(work, "aether_1.2.6")
        const src = path.join(tmp.path, "src-windows")
        const out = path.join(dl, "aether-windows-x64-1.2.7.zip")
        const script = path.join(dl, "update_windows.bat")
        const debug = path.join(tmp.path, "debug", "update.log")

        await fs.mkdir(dl, { recursive: true })
        await ver(cur, "1.2.6")
        await winApp(src)
        winZip(src, out)
        await fs.copyFile(path.join(update, "update_windows.bat"), script)

        run("cmd", ["/c", script, "1.2.7"], dl, {
          ...process.env,
          AETHER_CURRENT_DIR: cur,
          AETHER_WORK_DIR: "alpha & beta | gamma > delta < epsilon",
          AETHER_DEBUG_LOG: debug,
        })

        const text = await Bun.file(debug).text()
        expect(text).toContain("ENVR | AETHER_WORK_DIR=alpha & beta | gamma > delta < epsilon")
        expect(text).toContain("UPDATE RUN COMPLETE")
      } finally {
        await restore(prev)
      }
    },
    { timeout: 30000 },
  )

  windows(
    "windows script stops old runtime before restart",
    async () => {
      const links = winLinks()
      const prev = await stash(links)
      try {
        await using tmp = await tmpdir()
        const work = path.join(tmp.path, "aether")
        const dl = path.join(work, "downloads")
        const old = path.join(work, "aether_1.2.6")
        const src = path.join(tmp.path, "src-windows")
        const out = path.join(dl, "aether-windows-x64-1.2.7.zip")
        const script = path.join(dl, "update_windows.bat")

        await fs.mkdir(dl, { recursive: true })
        await ver(old, "1.2.6")
        await winApp(old)
        await winApp(src)
        winZip(src, out)
        await fs.copyFile(path.join(update, "update_windows.bat"), script)

        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(old, "aether.exe")], {
          stdio: "ignore",
        })
        try {
          expect(alive(child.pid)).toBe(true)
          run("cmd", ["/c", script, "1.2.7", "--restart"], dl, {
            ...process.env,
            AETHER_CURRENT_DIR: old,
          })
          expect(await waitDead(child.pid)).toBe(true)
        } finally {
          cleanup(child.pid)
        }
      } finally {
        await restore(prev)
      }
    },
    { timeout: 30000 },
  )

  test("windows update scripts hide helper consoles except extract progress", async () => {
    const text = await Bun.file(path.join(update, "update_windows.bat")).text()
    const lines = text
      .split(/\r?\n/)
      .filter((x) => x.includes("powershell -NoProfile") || x.includes("%PSH%") || x.includes("%PSV%"))
    const shown = lines.filter((x) => x.includes("Expand-Archive"))
    const bare = lines.filter(
      (x) =>
        x.includes("powershell -NoProfile") &&
        !x.includes('set "PSH=') &&
        !x.includes('set "PSV=') &&
        !x.includes("Expand-Archive"),
    )

    expect(shown).toHaveLength(1)
    expect(shown[0]).toContain('start "Aether Update" /wait %PSV%')
    expect(bare).toEqual([])
    expect(text).toContain('if defined AETHER_DEBUG_LOG if /I not "%AETHER_UPDATE_DEBUG_INHERITED%"=="1"')
    expect(text).toContain('set "AETHER_DEBUG_LOG=%DEBUG_LOG%"')
    expect(text).toContain('set "AETHER_UPDATE_DEBUG_INHERITED=1"')

    const launcher = await Bun.file(path.join(root, "packages", "opencode", "launcher", "Aether.vbs")).text()
    expect(
      launcher
        .split(/\r?\n/)
        .filter((x) => x.includes("powershell -NoProfile"))
        .every((x) => x.includes("-WindowStyle Hidden")),
    ).toBe(true)
  })
})
