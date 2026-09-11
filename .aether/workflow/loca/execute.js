import { mkdtemp, mkdir, writeFile, readdir, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

export async function execute(code, inputs, cfg, signal) {
  const python = Bun.which(cfg.python)
  if (!python) throw new Error("Python interpreter unavailable")
  const interpreter = await realpath(python)
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "loca-exec-")))
  const input = path.join(dir, "inputs")
  const output = path.join(dir, "outputs")
  await Promise.all([mkdir(input), mkdir(output)])
  await Promise.all(inputs.map((item, index) => writeFile(path.join(input, `${index}.txt`), item.content)))
  await writeFile(
    path.join(input, "manifest.json"),
    JSON.stringify(inputs.map((item, index) => ({ id: item.id, hash: item.hash, file: `${index}.txt` }))),
  )
  await writeFile(path.join(dir, "code.py"), code)
  await writeFile(
    path.join(dir, "launch.py"),
    `import resource, runpy\nresource.setrlimit(resource.RLIMIT_CPU, (20, 20))\nresource.setrlimit(resource.RLIMIT_NPROC, (0, 0))\nresource.setrlimit(resource.RLIMIT_FSIZE, (${cfg.bytes}, ${cfg.bytes}))\nresource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))\nrunpy.run_path(${JSON.stringify(path.join(dir, "code.py"))}, run_name="__main__")\n`,
  )
  const command = (() => {
    if (process.platform === "darwin" && Bun.which("sandbox-exec")) {
      const profile = `(version 1)
        (deny default)
        (allow process-exec (literal ${JSON.stringify(interpreter)}) ${interpreter.includes("/Python.framework/") ? `(subpath ${JSON.stringify(path.dirname(path.dirname(interpreter)))})` : ""})
        (allow process-fork)
        (allow signal (target self))
        (allow file-read-metadata)
        (allow sysctl-read)
        (allow mach-lookup (global-name "com.apple.system.logger"))
        (allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/Library/Apple")
          (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt")
          (subpath "/private/var/db/dyld") (literal "/dev/null") (literal "/dev/urandom")
          (subpath ${JSON.stringify(dir)}))
        (allow file-write* (subpath ${JSON.stringify(output)}) (literal "/dev/null"))`
      return ["/usr/bin/sandbox-exec", "-p", profile, interpreter, "-I", "-S", path.join(dir, "launch.py")]
    }
    if (process.platform === "linux" && Bun.which("bwrap"))
      return [
        "bwrap",
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind-try",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        dir,
        dir,
        "--bind",
        output,
        output,
        "--chdir",
        output,
        interpreter,
        "-I",
        "-S",
        path.join(dir, "launch.py"),
      ]
    throw new Error("No supported OS sandbox; execution is unavailable (never falls back to an unrestricted shell)")
  })()
  const proc = Bun.spawn(command, {
    cwd: output,
    env: { PATH: "/usr/bin:/bin", LOCA_INPUTS: input, LOCA_OUTPUTS: output },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stop = () => proc.kill("SIGKILL")
  signal?.addEventListener("abort", stop, { once: true })
  if (signal?.aborted) stop()
  const timer = setTimeout(stop, cfg.timeout)
  const capture = async (stream) => {
    const reader = stream.getReader()
    const chunks = []
    const size = { bytes: 0 }
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size.bytes += item.value.length
      if (size.bytes > cfg.bytes) {
        stop()
        throw new Error("Execution output limit exceeded")
      }
      chunks.push(Buffer.from(item.value))
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  // Always reap the process before cleanup, including output overflow and cancellation.
  return Promise.all([capture(proc.stdout), capture(proc.stderr), proc.exited])
    .then(async ([stdout, stderr, exit]) => {
      if (signal?.aborted) throw new Error("Execution cancelled")
      const names = await readdir(output, { withFileTypes: true })
      if (names.length > 32 || names.some((item) => !item.isFile()))
        throw new Error("Only up to 32 regular output files are supported")
      const files = await Promise.all(
        names.map(async (item) => ({ name: item.name, content: await readFile(path.join(output, item.name), "utf8") })),
      )
      if (files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > cfg.bytes)
        throw new Error("Execution file output limit exceeded")
      return {
        exit,
        stdout,
        stderr,
        files,
        interpreter,
        isolation: process.platform === "darwin" ? "sandbox-exec" : "bwrap",
        inputs: inputs.map((item) => ({ id: item.id, hash: item.hash })),
      }
    })
    .finally(async () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      stop()
      await proc.exited
      await rm(dir, { recursive: true, force: true })
    })
}
