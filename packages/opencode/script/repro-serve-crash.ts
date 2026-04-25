import fs from "fs/promises"
import path from "path"

type Profile = "base" | "git-off" | "summary-off" | "vcs-off" | "all-off"
type Mode = "copy" | "defaults" | "rm" | "mkdir" | "write" | "rm-mkdir" | "rm-mkdir-write"
type Case = {
  name: string
  profile: Profile
  mode: Mode
  dirs: string[]
  delay: number
  reset: boolean
  stream: boolean
}

function arg(name: string) {
  const key = `--${name}`
  const idx = process.argv.indexOf(key)
  if (idx < 0) return
  return process.argv[idx + 1]
}

const profile = (arg("profile") ?? "base") as Profile
const mode = (arg("mode") ?? "copy") as Mode
const root = path.resolve(arg("root") ?? "")
const source = path.resolve(arg("source") ?? "")
const dirs = (arg("dirs") ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x.length > 0)
const rounds = Number.parseInt(arg("rounds") ?? "10", 10)
const delay = Number.parseInt(arg("delay") ?? "120", 10)
const warmup = Number.parseInt(arg("warmup") ?? "3000", 10)
const wait = Number.parseInt(arg("wait") ?? "3000", 10)
const keep = arg("keep") === "true"
const url = arg("url") ?? "http://127.0.0.1:4096"
const boot = Number.parseInt(arg("boot") ?? "20000", 10)
const loops = Number.parseInt(arg("loops") ?? "1", 10)
const tries = Number.parseInt(arg("tries") ?? "1", 10)
const reset = (arg("reset") ?? "false") === "true"
const disable =
  (arg("disable-filewatch") ?? process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "false") === "true"
const skip =
  (arg("skip-dispose") ?? process.env.OPENCODE_EXPERIMENTAL_SKIP_DEFAULT_SKILLS_DISPOSE ?? "false") === "true"
const compare = (arg("compare") ?? "false") === "true"
const suite = arg("suite") ?? ""

function log(head: string, tail?: string) {
  console.log(`[serve-repro] ${head}${tail ? ` ${tail}` : ""}`)
}

function killTree(pid: number) {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"])
    return
  }
  Bun.spawnSync(["kill", "-9", String(pid)])
}

function servePids() {
  if (process.platform === "win32") {
    const out = Bun.spawnSync([
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*src/index.ts serve*' } | Select-Object -ExpandProperty ProcessId",
    ])
    const txt = out.stdout.toString()
    return txt
      .split(/\s+/)
      .map((x) => Number.parseInt(x, 10))
      .filter((x) => Number.isFinite(x) && x > 0)
  }
  const out = Bun.spawnSync(["bash", "-lc", "pgrep -f 'src/index.ts serve' || true"])
  const txt = out.stdout.toString()
  return txt
    .split(/\s+/)
    .map((x) => Number.parseInt(x, 10))
    .filter((x) => Number.isFinite(x) && x > 0)
}

async function clearServe(tag: string) {
  for (let i = 0; i < 4; i++) {
    const list = servePids()
    if (list.length === 0) return
    log("cleanup", `${tag} kill pids=${list.join(",")}`)
    for (const pid of list) killTree(pid)
    await Bun.sleep(300)
  }
  const list = servePids()
  if (list.length === 0) return
  throw new Error(`${tag}: failed to clear lingering serve processes: ${list.join(",")}`)
}

function env(profile: Profile, off: boolean) {
  const out: Record<string, string> = {
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
  }
  if (off) out.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  if (skip) out.OPENCODE_EXPERIMENTAL_SKIP_DEFAULT_SKILLS_DISPOSE = "true"
  if (profile === "git-off" || profile === "all-off") out.OPENCODE_EXPERIMENTAL_FILEWATCHER_DISABLE_GIT = "true"
  if (profile === "summary-off" || profile === "all-off") {
    out.OPENCODE_EXPERIMENTAL_FILEWATCHER_DISABLE_SUMMARY = "true"
  }
  if (profile === "vcs-off" || profile === "all-off") out.OPENCODE_EXPERIMENTAL_FILEWATCHER_DISABLE_VCS = "true"
  return out
}

async function copy(i: number) {
  const dir = path.join(root, `.repro-serve-copy-${Date.now()}-${i}`)
  await fs.cp(source, dir, { recursive: true })
  if (!keep) await fs.rm(dir, { recursive: true, force: true })
}

async function defaults(base: string) {
  await fetch(`${base}/config/skills/defaults?directory=${encodeURIComponent(root)}`, {
    method: "POST",
  })
}

async function clearDefaults() {
  const dir = path.join(root, ".aether", "skills")
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
}

function skillsDir() {
  return path.join(root, ".aether", "skills")
}

async function rmSkills() {
  await fs.rm(skillsDir(), { recursive: true, force: true })
}

async function mkdirSkills() {
  await fs.mkdir(skillsDir(), { recursive: true })
}

async function writeSkills(i: number) {
  const dir = skillsDir()
  await fs.mkdir(dir, { recursive: true })
  const jobs: Promise<unknown>[] = []
  for (let n = 0; n < 40; n++) {
    const file = path.join(dir, `probe-${i}-${n}.txt`)
    jobs.push(fs.writeFile(file, `${Date.now()}-${i}-${n}\n`, "utf8"))
  }
  await Promise.all(jobs)
}

async function relay(stream: ReadableStream<Uint8Array> | null, on: (txt: string) => void, isErr = false) {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const next = await reader.read()
    if (next.done) return
    const txt = decoder.decode(next.value, { stream: true })
    on(txt)
    if (isErr) process.stderr.write(txt)
    if (!isErr) process.stdout.write(txt)
  }
}

async function sse(dir: string, base: string) {
  const ctl = new AbortController()
  const path = `${base}/event?directory=${encodeURIComponent(dir)}`
  const done = fetch(path, {
    headers: { Accept: "text/event-stream" },
    signal: ctl.signal,
  })
    .then(async (res) => {
      if (!res.body) return
      const reader = res.body.getReader()
      while (true) {
        const next = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (next.done) return
      }
    })
    .catch(() => undefined)
  return {
    close: () => ctl.abort(),
    done,
  }
}

async function run(i: number, total: number, off: boolean, cfg: Case) {
  if (!source || source === root) throw new Error(`invalid source: ${source}`)
  if (!(await fs.stat(source)).isDirectory()) throw new Error(`source is not directory: ${source}`)
  if (!(await fs.stat(root)).isDirectory()) throw new Error(`root is not directory: ${root}`)
  await clearServe("preflight")

  const cwd = path.resolve(import.meta.dir, "../../..")
  const vars = env(cfg.profile, off)
  log(
    "start",
    `loop=${i}/${total} profile=${cfg.profile} mode=${cfg.mode} rounds=${rounds} root=${root} source=${source}`,
  )
  log(
    "env",
    `fw=${vars.OPENCODE_EXPERIMENTAL_FILEWATCHER ?? "unset"} disable=${vars.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "unset"} skip=${vars.OPENCODE_EXPERIMENTAL_SKIP_DEFAULT_SKILLS_DISPOSE ?? "unset"} git=${vars.OPENCODE_EXPERIMENTAL_FILEWATCHER_DISABLE_GIT ?? "unset"} sum=${vars.OPENCODE_EXPERIMENTAL_FILEWATCHER_DISABLE_SUMMARY ?? "unset"} vcs=${vars.OPENCODE_EXPERIMENTAL_FILEWATCHER_DISABLE_VCS ?? "unset"}`,
  )

  const child = Bun.spawn([process.execPath, "dev", "serve"], {
    cwd,
    env: { ...process.env, ...vars },
    stdout: "pipe",
    stderr: "pipe",
  })

  let stop = false
  let end = false
  const done = child.exited.then((code) => {
    end = true
    return code
  })
  let ready = false
  let base = url
  let wake: (() => void) | undefined
  const waitReady = new Promise<void>((resolve) => {
    wake = resolve
  })
  const on = (txt: string) => {
    if (!ready) {
      if (!txt.includes("opencode server listening on")) return
      const hit = txt.match(/opencode server listening on\s+(\S+)/)
      if (hit?.[1]) base = hit[1]
      ready = true
      wake?.()
      return
    }
    const hit = txt.match(/opencode server listening on\s+(\S+)/)
    if (hit?.[1]) base = hit[1]
  }
  const out = relay(child.stdout, on)
  const err = relay(child.stderr, on, true)
  const conns: Array<{ close: () => void; done: Promise<void> }> = []

  const stopChild = () => {
    if (end || child.killed) return
    log("stop", "sending SIGTERM")
    stop = true
    child.kill()
    setTimeout(() => {
      if (end) return
      log("stop", `force kill tree pid=${child.pid}`)
      killTree(child.pid)
    }, 3000)
  }

  try {
    await Promise.race([waitReady, Bun.sleep(boot)])
    if (!ready) throw new Error(`server did not become ready within ${boot}ms`)
    log("ready", `url=${base}`)
    if (cfg.stream) {
      conns.push(await sse(root, base))
      for (const dir of cfg.dirs) conns.push(await sse(dir, base))
    }
    log("sse", `count=${conns.length}`)
    await Bun.sleep(warmup)

    for (let n = 0; n < rounds; n++) {
      if (child.killed) break
      if (cfg.mode === "copy") {
        log("copy", `${n + 1}/${rounds}`)
        await copy(n)
      }
      if (cfg.mode === "defaults") {
        log("defaults", `${n + 1}/${rounds}`)
        if (cfg.reset) await clearDefaults()
        await defaults(base)
      }
      if (cfg.mode === "rm") {
        log("rm", `${n + 1}/${rounds}`)
        await rmSkills()
      }
      if (cfg.mode === "mkdir") {
        log("mkdir", `${n + 1}/${rounds}`)
        await mkdirSkills()
      }
      if (cfg.mode === "write") {
        log("write", `${n + 1}/${rounds}`)
        await writeSkills(n)
      }
      if (cfg.mode === "rm-mkdir") {
        log("rm-mkdir", `${n + 1}/${rounds}`)
        await rmSkills()
        await mkdirSkills()
      }
      if (cfg.mode === "rm-mkdir-write") {
        log("rm-mkdir-write", `${n + 1}/${rounds}`)
        await rmSkills()
        await mkdirSkills()
        await writeSkills(n)
      }
      await Bun.sleep(cfg.delay)
      if (child.killed) break
    }
    await Bun.sleep(wait)
  } finally {
    for (const item of conns) item.close()
    await Promise.allSettled(conns.map((item) => item.done))
    stopChild()
    const exit = await Promise.race([
      done.then((code) => ({ ok: true as const, code })),
      Bun.sleep(10000).then(() => ({ ok: false as const, code: -999 })),
    ])
    if (!exit.ok) {
      log("exit", `timeout waiting for child exit, force pid=${child.pid}`)
      killTree(child.pid)
      const retry = await Promise.race([done.then(() => true), Bun.sleep(5000).then(() => false)])
      if (!retry) throw new Error(`child did not exit after forced kill pid=${child.pid}`)
    }
    await Promise.race([Promise.allSettled([out, err]), Bun.sleep(2000)])
    const code = end ? await done : exit.code
    const crashed = !stop && code !== 0
    log("exit", `code=${code} crashed=${crashed ? 1 : 0} stopped=${stop ? 1 : 0}`)
    await clearServe("postflight")
    return crashed
  }
}

async function main() {
  const one: Case = {
    name: "single",
    profile,
    mode,
    dirs,
    delay,
    reset,
    stream: true,
  }

  if (suite === "quick") {
    const list: Case[] = [
      {
        name: "copy-multi",
        profile: "base",
        mode: "copy",
        dirs,
        delay: 20,
        reset: false,
        stream: true,
      },
      {
        name: "defaults-multi",
        profile: "all-off",
        mode: "defaults",
        dirs,
        delay: 80,
        reset: true,
        stream: true,
      },
      {
        name: "defaults-single",
        profile: "all-off",
        mode: "defaults",
        dirs: [],
        delay: 80,
        reset: true,
        stream: true,
      },
    ]
    const sum: Array<{ name: string; on: number; off: number }> = []
    for (const item of list) {
      log("suite", `start case=${item.name}`)
      let on = 0
      let off = 0
      for (let i = 1; i <= tries; i++) {
        const crashed = await run(i, tries, false, item)
        if (crashed) on += 1
        if (i < tries) await Bun.sleep(1000)
      }
      for (let i = 1; i <= tries; i++) {
        const crashed = await run(i, tries, true, item)
        if (crashed) off += 1
        if (i < tries) await Bun.sleep(1000)
      }
      const onRate = tries > 0 ? ((on / tries) * 100).toFixed(1) : "0.0"
      const offRate = tries > 0 ? ((off / tries) * 100).toFixed(1) : "0.0"
      log("suite", `${item.name} on crash=${on}/${tries} rate=${onRate}%`)
      log("suite", `${item.name} off crash=${off}/${tries} rate=${offRate}%`)
      sum.push({ name: item.name, on, off })
    }
    log("suite", "final-summary")
    for (const item of sum) {
      const onRate = tries > 0 ? ((item.on / tries) * 100).toFixed(1) : "0.0"
      const offRate = tries > 0 ? ((item.off / tries) * 100).toFixed(1) : "0.0"
      console.log(
        `[serve-repro] summary case=${item.name} on=${item.on}/${tries}(${onRate}%) off=${item.off}/${tries}(${offRate}%)`,
      )
    }
    return
  }

  if (suite === "reason") {
    const list: Case[] = [
      {
        name: "probe-rm",
        profile: "all-off",
        mode: "rm",
        dirs: [],
        delay: 80,
        reset: false,
        stream: true,
      },
      {
        name: "probe-mkdir",
        profile: "all-off",
        mode: "mkdir",
        dirs: [],
        delay: 80,
        reset: false,
        stream: true,
      },
      {
        name: "probe-write",
        profile: "all-off",
        mode: "write",
        dirs: [],
        delay: 80,
        reset: false,
        stream: true,
      },
      {
        name: "probe-rm-mkdir",
        profile: "all-off",
        mode: "rm-mkdir",
        dirs: [],
        delay: 80,
        reset: false,
        stream: true,
      },
      {
        name: "probe-rm-mkdir-write",
        profile: "all-off",
        mode: "rm-mkdir-write",
        dirs: [],
        delay: 80,
        reset: false,
        stream: true,
      },
      {
        name: "defaults-single",
        profile: "all-off",
        mode: "defaults",
        dirs: [],
        delay: 80,
        reset: true,
        stream: true,
      },
    ]
    const sum: Array<{ name: string; on: number; off: number }> = []
    for (const item of list) {
      log("suite", `start case=${item.name}`)
      let on = 0
      let off = 0
      for (let i = 1; i <= tries; i++) {
        const crashed = await run(i, tries, false, item)
        if (crashed) on += 1
        if (i < tries) await Bun.sleep(1000)
      }
      for (let i = 1; i <= tries; i++) {
        const crashed = await run(i, tries, true, item)
        if (crashed) off += 1
        if (i < tries) await Bun.sleep(1000)
      }
      const onRate = tries > 0 ? ((on / tries) * 100).toFixed(1) : "0.0"
      const offRate = tries > 0 ? ((off / tries) * 100).toFixed(1) : "0.0"
      log("suite", `${item.name} on crash=${on}/${tries} rate=${onRate}%`)
      log("suite", `${item.name} off crash=${off}/${tries} rate=${offRate}%`)
      sum.push({ name: item.name, on, off })
    }
    log("suite", "final-summary")
    for (const item of sum) {
      const onRate = tries > 0 ? ((item.on / tries) * 100).toFixed(1) : "0.0"
      const offRate = tries > 0 ? ((item.off / tries) * 100).toFixed(1) : "0.0"
      console.log(
        `[serve-repro] summary case=${item.name} on=${item.on}/${tries}(${onRate}%) off=${item.off}/${tries}(${offRate}%)`,
      )
    }
    return
  }

  if (suite === "reason-api") {
    const list: Case[] = [
      {
        name: "defaults-stream-reset",
        profile: "all-off",
        mode: "defaults",
        dirs: [],
        delay: 80,
        reset: true,
        stream: true,
      },
      {
        name: "defaults-stream-noreset",
        profile: "all-off",
        mode: "defaults",
        dirs: [],
        delay: 80,
        reset: false,
        stream: true,
      },
      {
        name: "defaults-nostream-reset",
        profile: "all-off",
        mode: "defaults",
        dirs: [],
        delay: 80,
        reset: true,
        stream: false,
      },
      {
        name: "defaults-nostream-noreset",
        profile: "all-off",
        mode: "defaults",
        dirs: [],
        delay: 80,
        reset: false,
        stream: false,
      },
      {
        name: "rm-mkdir-write-stream",
        profile: "all-off",
        mode: "rm-mkdir-write",
        dirs: [],
        delay: 80,
        reset: false,
        stream: true,
      },
      {
        name: "rm-mkdir-write-nostream",
        profile: "all-off",
        mode: "rm-mkdir-write",
        dirs: [],
        delay: 80,
        reset: false,
        stream: false,
      },
    ]
    const sum: Array<{ name: string; on: number; off: number }> = []
    for (const item of list) {
      log("suite", `start case=${item.name}`)
      let on = 0
      let off = 0
      for (let i = 1; i <= tries; i++) {
        const crashed = await run(i, tries, false, item)
        if (crashed) on += 1
        if (i < tries) await Bun.sleep(1000)
      }
      for (let i = 1; i <= tries; i++) {
        const crashed = await run(i, tries, true, item)
        if (crashed) off += 1
        if (i < tries) await Bun.sleep(1000)
      }
      const onRate = tries > 0 ? ((on / tries) * 100).toFixed(1) : "0.0"
      const offRate = tries > 0 ? ((off / tries) * 100).toFixed(1) : "0.0"
      log("suite", `${item.name} on crash=${on}/${tries} rate=${onRate}%`)
      log("suite", `${item.name} off crash=${off}/${tries} rate=${offRate}%`)
      sum.push({ name: item.name, on, off })
    }
    log("suite", "final-summary")
    for (const item of sum) {
      const onRate = tries > 0 ? ((item.on / tries) * 100).toFixed(1) : "0.0"
      const offRate = tries > 0 ? ((item.off / tries) * 100).toFixed(1) : "0.0"
      console.log(
        `[serve-repro] summary case=${item.name} on=${item.on}/${tries}(${onRate}%) off=${item.off}/${tries}(${offRate}%)`,
      )
    }
    return
  }

  if (compare) {
    const on = { crash: 0, ok: 0 }
    const off = { crash: 0, ok: 0 }
    for (let i = 1; i <= tries; i++) {
      const crashed = await run(i, tries, false, one)
      if (crashed) on.crash += 1
      if (!crashed) on.ok += 1
      if (i < tries) await Bun.sleep(1000)
    }
    for (let i = 1; i <= tries; i++) {
      const crashed = await run(i, tries, true, one)
      if (crashed) off.crash += 1
      if (!crashed) off.ok += 1
      if (i < tries) await Bun.sleep(1000)
    }
    const onRate = tries > 0 ? ((on.crash / tries) * 100).toFixed(1) : "0.0"
    const offRate = tries > 0 ? ((off.crash / tries) * 100).toFixed(1) : "0.0"
    log("compare", `on crash=${on.crash}/${tries} rate=${onRate}%`)
    log("compare", `off crash=${off.crash}/${tries} rate=${offRate}%`)
    return
  }

  for (let i = 1; i <= loops; i++) {
    const crashed = await run(i, loops, disable, one)
    if (crashed) return
    if (i < loops) await Bun.sleep(1000)
  }
}

await main()
process.exit(0)
