import { createSignal } from "solid-js"

export type FeishuStatus = "idle" | "loading" | "connected" | "error"

export const [feishuStatus, setFeishuStatus] = createSignal<FeishuStatus>("idle")
