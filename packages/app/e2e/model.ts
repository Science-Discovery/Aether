export const model = "e2e/test-model"

export function config(url?: string) {
  const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")
  return JSON.stringify({
    ...cfg,
    model: process.env.OPENCODE_E2E_MODEL ?? model,
    provider: {
      ...cfg.provider,
      e2e: {
        name: "E2E",
        npm: "@ai-sdk/openai-compatible",
        options: {
          apiKey: "e2e-local-only",
          baseURL: url ?? "http://127.0.0.1:1/v1",
        },
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 128000, output: 8192 },
          },
          "backup-model": {
            name: "Test Model Backup",
            limit: { context: 128000, output: 8192 },
          },
        },
      },
    },
  })
}
