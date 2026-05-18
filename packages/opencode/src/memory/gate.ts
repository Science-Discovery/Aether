export type QuickReflectGateInput = {
  text: string
  intent: "explicit" | "observed"
  op: "remember" | "forget"
  shortcutTriggers?: string[]
}

export type QuickReflectGateDecision = {
  shouldRun: boolean
  priority: "normal" | "important"
  reason: string
}

const REMEMBER_RE = /(记住|以后都|别忘了|remember|keep in mind|please note)/i
const FORGET_RE = /(忘掉|忘记|不要记得|别记|forget|don't remember|do not remember)/i
const PREFERENCE_RE = /(我.{0,16}(喜欢|偏好|希望|倾向|常用|主要用|习惯|要求|强调|建议)|默认|以后|prefer|preference|by default|always)/i
const PROJECT_RE = /(这个项目|当前项目|此 repo|这个 repo|this project|current project|this repo)/i
const TASK_RE = /(待办|之后|每天|定期|继续|follow up|todo|remind|schedule|daily)/i
const SENSITIVE_RE = /(身份证|护照|银行卡|信用卡|密码|住址|家庭住址|电话号码|手机号|phone number|address|password|credit card|passport|ssn|social security|diagnosed|病史|诊断|宗教|政治倾向)/i

export function hasRememberIntent(text: string) {
  return REMEMBER_RE.test(text)
}

export function hasForgetIntent(text: string) {
  return FORGET_RE.test(text)
}

export function hasSensitiveSignal(text: string) {
  return SENSITIVE_RE.test(text)
}

export function shouldQuickReflect(input: QuickReflectGateInput): QuickReflectGateDecision {
  const text = input.text.trim()
  if (!text) return { shouldRun: false, priority: "normal", reason: "empty" }
  if (input.op === "forget" || hasForgetIntent(text)) {
    return { shouldRun: true, priority: "important", reason: "explicit forget intent" }
  }
  if (input.intent === "explicit" || hasRememberIntent(text)) {
    return { shouldRun: true, priority: "important", reason: "explicit remember intent" }
  }
  if (hasSensitiveSignal(text)) return { shouldRun: false, priority: "normal", reason: "sensitive observed signal" }
  if (PROJECT_RE.test(text)) return { shouldRun: true, priority: "normal", reason: "project-scoped signal" }
  if (PREFERENCE_RE.test(text)) return { shouldRun: true, priority: "normal", reason: "preference signal" }
  if (TASK_RE.test(text)) return { shouldRun: true, priority: "normal", reason: "persistent task signal" }
  const shortcutTriggers = input.shortcutTriggers ?? []
  if (shortcutTriggers.some((trigger) => text.toLowerCase().includes(trigger.toLowerCase()))) {
    return { shouldRun: true, priority: "normal", reason: "shortcut trigger" }
  }
  return { shouldRun: false, priority: "normal", reason: "low signal" }
}
