import { dlopen, ptr } from "bun:ffi"
import { Log } from "./log"

const log = Log.create({ service: "job-object" })

// Windows Job Object tying spawned child processes to this server's
// lifetime. The job is created with KILL_ON_JOB_CLOSE and its handle is
// deliberately never closed, so when the server process dies — even on a
// hard crash — the kernel kills every assigned child and its descendants
// (children inherit job membership). No-op on other platforms; assignment
// is best-effort (e.g. it can fail under restrictive nested-job policies).

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001
// sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64; dwLimitFlags sits at
// offset 20 inside the embedded JOBOBJECT_BASIC_LIMIT_INFORMATION.
const INFO_SIZE = 160
const LIMIT_FLAGS_OFFSET = 20

let assign: ((pid: number) => boolean) | undefined

function init(): ((pid: number) => boolean) | undefined {
  const { symbols } = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "i32", "ptr", "i32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  })
  const job = symbols.CreateJobObjectW(null, null)
  if (!job) return undefined
  const info = new Uint8Array(INFO_SIZE)
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
  if (!symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(info), INFO_SIZE)) {
    symbols.CloseHandle(job)
    return undefined
  }
  return (pid: number) => {
    const proc = symbols.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
    if (!proc) return false
    try {
      return symbols.AssignProcessToJobObject(job, proc) !== 0
    } finally {
      symbols.CloseHandle(proc)
    }
  }
}

export function assignToServerJob(pid: number): void {
  if (process.platform !== "win32") return
  try {
    assign ??= init()
    if (assign && !assign(pid)) log.debug("job assignment failed", { pid })
  } catch (e) {
    log.debug("job object unavailable", { error: e instanceof Error ? e.message : String(e) })
  }
}
