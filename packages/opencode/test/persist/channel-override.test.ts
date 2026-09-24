import { describe, expect, test } from "bun:test"
import { channelSlug } from "../../src/persist/naming"

const key = "OPENCODE_CHANNEL"

function restore(had: boolean, value: string | undefined, env: string | undefined) {
  if (had) (globalThis as any)[key] = value
  else delete (globalThis as any)[key]
  if (env === undefined) delete process.env[key]
  else process.env[key] = env
}

describe("channel slug runtime override", () => {
  test("source run without define or env falls back to local", () => {
    const had = key in globalThis
    const global = (globalThis as any)[key] as string | undefined
    const env = process.env[key]
    try {
      delete (globalThis as any)[key]
      delete process.env[key]
      expect(channelSlug()).toBe("local")
    } finally {
      restore(had, global, env)
    }
  })

  test("env overrides local when no build-time define exists", () => {
    const had = key in globalThis
    const global = (globalThis as any)[key] as string | undefined
    const env = process.env[key]
    try {
      delete (globalThis as any)[key]
      process.env[key] = "test"
      expect(channelSlug()).toBe("test")
    } finally {
      restore(had, global, env)
    }
  })

  test("build-time define wins over env", () => {
    const had = key in globalThis
    const global = (globalThis as any)[key] as string | undefined
    const env = process.env[key]
    try {
      ;(globalThis as any)[key] = "prod"
      process.env[key] = "test"
      expect(channelSlug()).toBe("prod")
    } finally {
      restore(had, global, env)
    }
  })

  test("empty env is treated as unset", () => {
    const had = key in globalThis
    const global = (globalThis as any)[key] as string | undefined
    const env = process.env[key]
    try {
      delete (globalThis as any)[key]
      process.env[key] = ""
      expect(channelSlug()).toBe("local")
    } finally {
      restore(had, global, env)
    }
  })

  test("env value is sanitized and latest/beta normalize to latest", () => {
    const had = key in globalThis
    const global = (globalThis as any)[key] as string | undefined
    const env = process.env[key]
    try {
      delete (globalThis as any)[key]
      process.env[key] = "my channel/1"
      expect(channelSlug()).toBe("my-channel-1")
      process.env[key] = "beta"
      expect(channelSlug()).toBe("latest")
    } finally {
      restore(had, global, env)
    }
  })
})
