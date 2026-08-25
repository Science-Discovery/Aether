import { describe, expect, test } from "bun:test"
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { createProviderRefresh, type ProviderTarget } from "./provider-refresh"

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function list(id: string, deprecated = false): ProviderListResponse {
  return {
    all: [
      {
        id,
        name: id,
        env: [],
        models: deprecated
          ? {
              old: {
                id: "old",
                name: "old",
                release_date: "2020-01-01",
                attachment: false,
                reasoning: false,
                tool_call: false,
                limit: { context: 1, output: 1 },
                status: "deprecated",
              },
            }
          : {},
      },
    ],
    connected: [id],
    default: {},
  }
}

function setup(input: { global: ProviderTarget; children?: Record<string, ProviderTarget>; errors?: string[] }) {
  const children = input.children ?? {}
  return createProviderRefresh({
    global: () => input.global,
    child: (directory) => children[directory],
    list: () => Object.keys(children),
    error: (key) => input.errors?.push(key),
  })
}

describe("provider refresh", () => {
  test("refreshes global and every child while normalizing results", async () => {
    const applied: Record<string, ProviderListResponse> = {}
    const target = (key: string): ProviderTarget => {
      const identity = {}
      return {
        key,
        identity,
        current: () => identity,
        load: async () => list(key, true),
        apply: (data) => {
          applied[key] = data
        },
      }
    }
    const refresh = setup({
      global: target("global"),
      children: { a: target("a"), b: target("b") },
    })

    await refresh.all()

    expect(Object.keys(applied).sort()).toEqual(["a", "b", "global"])
    expect(Object.keys(applied.global!.all[0]!.models)).toEqual([])
    expect(Object.keys(applied.a!.all[0]!.models)).toEqual([])
  })

  test("ignores an older response that resolves after a newer refresh", async () => {
    const old = defer<ProviderListResponse>()
    const fresh = defer<ProviderListResponse>()
    const applied: string[] = []
    const identity = {}
    const loads = [old.promise, fresh.promise]
    const target: ProviderTarget = {
      key: "global",
      identity,
      current: () => identity,
      load: () => loads.shift()!,
      apply: (data) => applied.push(data.connected[0]!),
    }
    const refresh = setup({ global: target })

    const first = refresh.global()
    const second = refresh.global()
    fresh.resolve(list("fresh"))
    await second
    old.resolve(list("old"))
    await first

    expect(applied).toEqual(["fresh"])
  })

  test("ignores a response after its child store is replaced", async () => {
    const pending = defer<ProviderListResponse>()
    const old = {}
    const fresh = {}
    let current: object = old
    const applied: string[] = []
    const child: ProviderTarget = {
      key: "directory:a",
      identity: old,
      current: () => current,
      load: () => pending.promise,
      apply: (data) => applied.push(data.connected[0]!),
    }
    const refresh = setup({
      global: { ...child, key: "global" },
      children: { a: child },
    })

    const request = refresh.child("a")
    current = fresh
    pending.resolve(list("old"))
    await request

    expect(applied).toEqual([])
  })

  test("keeps refreshing other targets when one child fails", async () => {
    const applied: string[] = []
    const errors: string[] = []
    const target = (key: string, fail = false): ProviderTarget => {
      const identity = {}
      return {
        key,
        identity,
        current: () => identity,
        load: async () => {
          if (fail) throw new Error(key)
          return list(key)
        },
        apply: (data) => applied.push(data.connected[0]!),
      }
    }
    const refresh = setup({
      global: target("global"),
      children: { broken: target("broken", true), child: target("child") },
      errors,
    })

    await refresh.all()

    expect(applied.sort()).toEqual(["child", "global"])
    expect(errors).toEqual(["broken"])
  })
})
