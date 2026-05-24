const ranked = [
  "tatu-maas",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "alibaba-cn",
  "alibaba-coding-plan-cn",
  "deepseek",
  "moonshotai-cn",
  "moonshot-cn",
  "zhipuai",
  "zhipuai-coding-plan",
  "minimax-cn",
  "minimax-cn-coding-plan",
  "tencent-coding-plan",
  "siliconflow-cn",
  "baidu",
  "qianfan",
  "ernie",
  "baidu-qianfan",
  "opencode",
  "opencode-go",
  "anthropic",
  "openai",
  "github-copilot",
  "google",
  "openrouter",
  "vercel",
]

export function rank(id: string) {
  const index = ranked.indexOf(id)
  return index >= 0 ? index : ranked.length
}
