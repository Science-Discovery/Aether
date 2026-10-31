import { test as base, expect } from "../fixtures"

export const test = base.extend<{ models: void }>({
  models: [
    async ({ backend }, use) => {
      const sdk = backend.sdk()
      const before = await sdk.global.config.get().then((res) => res.data?.disabled_models ?? [])
      await sdk.global.config.update({ config: { disabled_models: [] } })
      try {
        await use()
      } finally {
        await sdk.global.config.update({ config: { disabled_models: before } })
        await expect.poll(() => sdk.global.config.get().then((res) => res.data?.disabled_models ?? [])).toEqual(before)
      }
    },
    { auto: true },
  ],
})

export { expect }
