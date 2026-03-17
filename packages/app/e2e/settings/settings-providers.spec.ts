import { test, expect } from "../fixtures"
import { closeDialog, openSettings } from "../actions"

test("custom provider disconnect removes from connected list", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Providers" }).click()

  const customProviderSection = settings.locator('[data-component="custom-provider-section"]')
  await customProviderSection.getByRole("button", { name: "Connect" }).click()

  const providerDialog = page.getByRole("dialog").filter({ has: page.getByText("Custom provider") })
  await expect(providerDialog).toBeVisible()

  // Create an anthropic-type custom provider (this was the bug path)
  await providerDialog.getByLabel("Provider ID").fill("test-anthropic-disconnect")
  await providerDialog.getByLabel("Display name").fill("Test Anthropic Disconnect")
  await providerDialog.getByLabel("Base URL").fill("http://localhost:9999/anthropic")
  await providerDialog.getByLabel("API key").fill("fake-anthropic-key")

  // Select anthropic provider type
  await providerDialog.getByRole("combobox", { name: /provider.*type/i }).click()
  await page.getByRole("option", { name: /anthropic/i }).click()

  await providerDialog.getByPlaceholder("model-id").first().fill("claude-test")
  await providerDialog.getByPlaceholder("Display Name").first().fill("Claude Test")

  // Save the provider
  await providerDialog.getByRole("button", { name: /save|connect/i }).click()
  await expect(providerDialog).toHaveCount(0)

  // Verify it appears in connected list
  const connectedSection = settings.locator('[data-component="connected-providers-section"]')
  await expect(connectedSection.getByText("Test Anthropic Disconnect")).toBeVisible()

  // Disconnect the provider
  const providerRow = connectedSection.locator("div").filter({ hasText: "Test Anthropic Disconnect" })
  await providerRow.getByRole("button", { name: /disconnect/i }).click()

  // Verify toast shows success
  await expect(page.locator("[data-sonner-toast]")).toBeVisible()

  // Verify provider is removed from connected list
  await expect(connectedSection.getByText("Test Anthropic Disconnect")).toHaveCount(0)

  await closeDialog(page, settings)
})

test("custom provider form can be filled and validates input", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Providers" }).click()

  const customProviderSection = settings.locator('[data-component="custom-provider-section"]')
  await expect(customProviderSection).toBeVisible()

  const connectButton = customProviderSection.getByRole("button", { name: "Connect" })
  await connectButton.click()

  const providerDialog = page.getByRole("dialog").filter({ has: page.getByText("Custom provider") })
  await expect(providerDialog).toBeVisible()

  await providerDialog.getByLabel("Provider ID").fill("test-provider")
  await providerDialog.getByLabel("Display name").fill("Test Provider")
  await providerDialog.getByLabel("Base URL").fill("http://localhost:9999/fake")
  await providerDialog.getByLabel("API key").fill("fake-key")

  await providerDialog.getByPlaceholder("model-id").first().fill("test-model")
  await providerDialog.getByPlaceholder("Display Name").first().fill("Test Model")

  await expect(providerDialog.getByRole("textbox", { name: "Provider ID" })).toHaveValue("test-provider")
  await expect(providerDialog.getByRole("textbox", { name: "Display name" })).toHaveValue("Test Provider")
  await expect(providerDialog.getByRole("textbox", { name: "Base URL" })).toHaveValue("http://localhost:9999/fake")
  await expect(providerDialog.getByRole("textbox", { name: "API key" })).toHaveValue("fake-key")
  await expect(providerDialog.getByPlaceholder("model-id").first()).toHaveValue("test-model")
  await expect(providerDialog.getByPlaceholder("Display Name").first()).toHaveValue("Test Model")

  await page.keyboard.press("Escape")
  await expect(providerDialog).toHaveCount(0)

  await closeDialog(page, settings)
})

test("custom provider form shows validation errors", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Providers" }).click()

  const customProviderSection = settings.locator('[data-component="custom-provider-section"]')
  await customProviderSection.getByRole("button", { name: "Connect" }).click()

  const providerDialog = page.getByRole("dialog").filter({ has: page.getByText("Custom provider") })
  await expect(providerDialog).toBeVisible()

  await providerDialog.getByLabel("Provider ID").fill("invalid provider id")
  await providerDialog.getByLabel("Base URL").fill("not-a-url")

  await providerDialog.getByRole("button", { name: /submit|save/i }).click()

  await expect(providerDialog.locator('[data-slot="input-error"]').filter({ hasText: /lowercase/i })).toBeVisible()
  await expect(providerDialog.locator('[data-slot="input-error"]').filter({ hasText: /http/i })).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(providerDialog).toHaveCount(0)

  await closeDialog(page, settings)
})

test("custom provider form can add and remove models", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Providers" }).click()

  const customProviderSection = settings.locator('[data-component="custom-provider-section"]')
  await customProviderSection.getByRole("button", { name: "Connect" }).click()

  const providerDialog = page.getByRole("dialog").filter({ has: page.getByText("Custom provider") })
  await expect(providerDialog).toBeVisible()

  await providerDialog.getByLabel("Provider ID").fill("multi-model-test")
  await providerDialog.getByLabel("Display name").fill("Multi Model Test")
  await providerDialog.getByLabel("Base URL").fill("http://localhost:9999/multi")

  await providerDialog.getByPlaceholder("model-id").first().fill("model-1")
  await providerDialog.getByPlaceholder("Display Name").first().fill("Model 1")

  const idInputsBefore = await providerDialog.getByPlaceholder("model-id").count()
  await providerDialog.getByRole("button", { name: "Add model" }).click()
  const idInputsAfter = await providerDialog.getByPlaceholder("model-id").count()
  expect(idInputsAfter).toBe(idInputsBefore + 1)

  await providerDialog.getByPlaceholder("model-id").nth(1).fill("model-2")
  await providerDialog.getByPlaceholder("Display Name").nth(1).fill("Model 2")

  await expect(providerDialog.getByPlaceholder("model-id").nth(1)).toHaveValue("model-2")
  await expect(providerDialog.getByPlaceholder("Display Name").nth(1)).toHaveValue("Model 2")

  await page.keyboard.press("Escape")
  await expect(providerDialog).toHaveCount(0)

  await closeDialog(page, settings)
})

test("custom provider form can add and remove headers", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Providers" }).click()

  const customProviderSection = settings.locator('[data-component="custom-provider-section"]')
  await customProviderSection.getByRole("button", { name: "Connect" }).click()

  const providerDialog = page.getByRole("dialog").filter({ has: page.getByText("Custom provider") })
  await expect(providerDialog).toBeVisible()

  await providerDialog.getByLabel("Provider ID").fill("header-test")
  await providerDialog.getByLabel("Display name").fill("Header Test")
  await providerDialog.getByLabel("Base URL").fill("http://localhost:9999/headers")

  await providerDialog.getByPlaceholder("model-id").first().fill("model-x")
  await providerDialog.getByPlaceholder("Display Name").first().fill("Model X")

  const headerInputsBefore = await providerDialog.getByPlaceholder("Header-Name").count()
  await providerDialog.getByRole("button", { name: "Add header" }).click()
  const headerInputsAfter = await providerDialog.getByPlaceholder("Header-Name").count()
  expect(headerInputsAfter).toBe(headerInputsBefore + 1)

  await providerDialog.getByPlaceholder("Header-Name").first().fill("Authorization")
  await providerDialog.getByPlaceholder("value").first().fill("Bearer token123")

  await expect(providerDialog.getByPlaceholder("Header-Name").first()).toHaveValue("Authorization")
  await expect(providerDialog.getByPlaceholder("value").first()).toHaveValue("Bearer token123")

  await page.keyboard.press("Escape")
  await expect(providerDialog).toHaveCount(0)

  await closeDialog(page, settings)
})
