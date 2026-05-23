export const PROVIDER_NOTES = [
  { match: (id: string) => id === "tatu-maas", key: "dialog.provider.maas.note" },
  { match: (id: string) => id.startsWith("xiaomi"), key: "dialog.provider.xiaomi.note" },
  { match: (id: string) => id === "alibaba-cn", key: "dialog.provider.alibaba.note" },
  { match: (id: string) => id.startsWith("alibaba-coding-plan"), key: "dialog.provider.alibabaCodingPlan.note" },
  { match: (id: string) => id === "deepseek", key: "dialog.provider.deepseek.note" },
  { match: (id: string) => id === "moonshotai-cn" || id === "moonshot-cn", key: "dialog.provider.moonshot.note" },
  { match: (id: string) => id === "zhipuai", key: "dialog.provider.zhipu.note" },
  { match: (id: string) => id === "zhipuai-coding-plan", key: "dialog.provider.zhipuCodingPlan.note" },
  { match: (id: string) => id === "minimax-cn", key: "dialog.provider.minimax.note" },
  { match: (id: string) => id === "tencent-coding-plan", key: "dialog.provider.tencentCodingPlan.note" },
  { match: (id: string) => id.startsWith("siliconflow"), key: "dialog.provider.siliconflow.note" },
  { match: (id: string) => ["baidu", "qianfan", "ernie", "baidu-qianfan"].includes(id), key: "dialog.provider.baidu.note" },
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

export function providerNote(id: string) {
  return PROVIDER_NOTES.find((item) => item.match(id))?.key
}
