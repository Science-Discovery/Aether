export const popularProviders = [
  "opencode",
  "opencode-go",  
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "alibaba-cn",
  "baidu",
  "qianfan",
  "tatu-maas",
  "siliconflow-cn",
  "deepseek",
  "zhipuai"
]

export function rank(id: string) {
  const index = popularProviders.indexOf(id)
  return index >= 0 ? index : popularProviders.length
}
