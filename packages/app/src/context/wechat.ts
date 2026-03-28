import { createSignal } from "solid-js"

export type WeChatStatus = "idle" | "loading" | "qrcode" | "connected" | "error"

export const [wechatStatus, setWechatStatus] = createSignal<WeChatStatus>("idle")
