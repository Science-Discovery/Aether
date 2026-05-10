// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"

declare const OPENCODE_LIBC: string | undefined

export function libc() {
  if (process.platform !== "linux") return
  if (process.env.OPENCODE_LIBC) return process.env.OPENCODE_LIBC
  if (typeof OPENCODE_LIBC !== "undefined" && OPENCODE_LIBC) return OPENCODE_LIBC
  const report = process.report?.getReport?.()
  const header =
    typeof report === "object" && report && "header" in report && typeof report.header === "object" && report.header
      ? report.header
      : undefined
  return typeof header === "object" && header && "glibcVersionRuntime" in header && typeof header.glibcVersionRuntime === "string"
    ? "glibc"
    : "musl"
}

export function name() {
  const abi = libc()
  return `@parcel/watcher-${process.platform}-${process.arch}${abi ? `-${abi}` : ""}`
}

function binding() {
  if (process.platform === "darwin" && process.arch === "arm64") return require("@parcel/watcher-darwin-arm64")
  if (process.platform === "darwin" && process.arch === "x64") return require("@parcel/watcher-darwin-x64")
  if (process.platform === "linux" && process.arch === "arm64" && libc() === "glibc")
    return require("@parcel/watcher-linux-arm64-glibc")
  if (process.platform === "linux" && process.arch === "arm64" && libc() === "musl")
    return require("@parcel/watcher-linux-arm64-musl")
  if (process.platform === "linux" && process.arch === "x64" && libc() === "glibc")
    return require("@parcel/watcher-linux-x64-glibc")
  if (process.platform === "linux" && process.arch === "x64" && libc() === "musl")
    return require("@parcel/watcher-linux-x64-musl")
  if (process.platform === "win32" && process.arch === "arm64") return require("@parcel/watcher-win32-arm64")
  if (process.platform === "win32" && process.arch === "x64") return require("@parcel/watcher-win32-x64")
}

export function load() {
  try {
    const value = binding()
    if (!value) {
      return {
        name: name(),
        value: require("@parcel/watcher") as typeof import("@parcel/watcher"),
      }
    }
    return {
      name: name(),
      value: createWrapper(value) as typeof import("@parcel/watcher"),
    }
  } catch (error) {
    try {
      return {
        name: name(),
        error,
        value: require("@parcel/watcher") as typeof import("@parcel/watcher"),
      }
    } catch (fallback) {
      return {
        name: name(),
        error,
        fallback,
      }
    }
  }
}

export function backend() {
  if (process.platform === "win32") return "windows" as const
  if (process.platform === "darwin") return "fs-events" as const
  if (process.platform === "linux") return "inotify" as const
}
