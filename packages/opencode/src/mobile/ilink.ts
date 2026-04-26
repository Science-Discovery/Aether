import crypto from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { basename, extname } from "node:path"

const VERSION = "1.0.2"
const POLL_TIMEOUT = 35
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
const MAX_TEXT_LENGTH = 2000

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
}

const extMime = (file: string) => MIME_MAP[extname(file).toLowerCase()] ?? "application/octet-stream"

const mediaType = (file: string) => {
  const type = extMime(file)
  if (type.startsWith("video/")) return { upload: 2, item: 5, kind: "video" as const }
  if (type.startsWith("image/")) return { upload: 1, item: 2, kind: "image" as const }
  return { upload: 3, item: 4, kind: "file" as const }
}

const uin = () => Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64")

const clientId = () => `wechat-agent-sdk-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`

const aesSize = (n: number) => Math.ceil((n + 1) / 16) * 16

const aesEnc = (buf: Buffer, key: Buffer) => {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(buf), cipher.final()])
}

function stripMarkdown(text: string): string {
  if (!text) return text
  text = text.replace(/```\w*\n(.*?)```/gs, "$1")
  text = text.replace(/`([^`]+)`/g, "$1")
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]")
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  text = text.replace(/^#{1,6}\s+/gm, "")
  text = text.replace(/\*\*(.+?)\*\*/g, "$1")
  text = text.replace(/__(.+?)__/g, "$1")
  text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "$1")
  text = text.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "$1")
  text = text.replace(/~~(.+?)~~/g, "$1")
  text = text.replace(/^[-*_]{3,}\s*$/gm, "————")
  return text.trim()
}

function splitText(text: string, max: number = MAX_TEXT_LENGTH): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining) {
    if (remaining.length <= max) {
      chunks.push(remaining)
      break
    }
    let pos = remaining.lastIndexOf("\n\n", max)
    if (pos === -1) pos = remaining.lastIndexOf("\n", max)
    if (pos === -1) pos = max
    chunks.push(remaining.slice(0, pos).trimEnd())
    remaining = remaining.slice(pos).trimStart()
  }
  return chunks
}

async function post(url: string, body: unknown, token?: string, timeoutMs?: number) {
  const text = JSON.stringify(body)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": uin(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: text,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`ilink ${res.status}: ${raw}`)
  return raw ? JSON.parse(raw) : {}
}

async function get(url: string, params: Record<string, string>, token?: string, timeoutMs?: number) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${url}?${qs}`, {
    headers: {
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": uin(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`ilink ${res.status}: ${raw}`)
  return raw ? JSON.parse(raw) : {}
}

function baseInfo() {
  return { channel_version: VERSION }
}

// ── Login ──────────────────────────────────────────────────────────────────────

export interface QRInfo {
  qr_url: string
  uuid: string
}

export async function requestQRCode(baseUrl: string, token?: string): Promise<QRInfo> {
  const data = await get(`${baseUrl.replace(/\/$/, "")}/ilink/bot/get_bot_qrcode`, { bot_type: "3" }, token, 10000)
  const qr_url = data.qrcode_img_content || data.qrcode_url || data.qrcodeUrl || ""
  const uuid = data.qrcode || data.uuid || ""
  if (!qr_url || !uuid) throw new Error(`Failed to get QR code: ${JSON.stringify(data).slice(0, 200)}`)
  return { qr_url, uuid }
}

export interface LoginStatusResult {
  status: "pending" | "scanned" | "confirmed" | "expired" | "error"
  token?: string
  bot_id?: string
  user_id?: string
  base_url?: string
  message?: string
}

export async function checkLoginStatus(baseUrl: string, uuid: string, token?: string): Promise<LoginStatusResult> {
  try {
    const data = await get(`${baseUrl.replace(/\/$/, "")}/ilink/bot/get_qrcode_status`, { qrcode: uuid }, token, 10000)
    const status = (data.status || "pending") as string
    if (status === "confirmed") {
      const t = data.bot_token || ""
      return {
        status: "confirmed",
        token: t,
        bot_id: data.ilink_bot_id || "",
        user_id: data.ilink_user_id || "",
        base_url: data.baseurl || "",
      }
    }
    if (status === "scaned" || status === "scanned") return { status: "scanned" }
    if (status === "expired") return { status: "expired" }
    if (status === "error") return { status: "error", message: data.message || "" }
    return { status: "pending" }
  } catch {
    return { status: "pending" }
  }
}

// ── Receive (long-poll) ────────────────────────────────────────────────────────

export interface PollResult {
  messages: dict[]
  cursor: string
  expired: boolean
}

type dict = Record<string, any>

export async function getUpdates(baseUrl: string, token: string, cursor: string): Promise<PollResult> {
  try {
    const data = await post(
      `${baseUrl.replace(/\/$/, "")}/ilink/bot/getupdates`,
      { get_updates_buf: cursor, base_info: baseInfo() },
      token,
      (POLL_TIMEOUT + 10) * 1000,
    )
    const newCursor = data.get_updates_buf || cursor
    const msgs = data.msgs || []
    const ret = data.ret ?? 0
    const errcode = data.errcode ?? 0
    const expired = errcode === -14 || ret === -14
    if (expired) return { messages: [], cursor: newCursor, expired: true }
    return { messages: msgs, cursor: newCursor, expired: false }
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.message?.includes("timeout")) {
      return { messages: [], cursor, expired: false }
    }
    throw err
  }
}

// ── Message parsing ────────────────────────────────────────────────────────────

export interface ParsedMessage {
  conversation_id: string
  text: string
  message_id: string
  context_token: string
  raw: dict
}

const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5

function extractText(itemList: dict[]): string {
  const parts: string[] = []
  for (const item of itemList) {
    const t = item.type ?? 0
    if (t === ITEM_TEXT) {
      const text = (item.text_item ?? {}).text ?? ""
      if (text) parts.push(text)
      const ref = item.ref_msg
      if (ref) {
        const refItem = ref.message_item ?? {}
        const refText = (refItem.text_item ?? {}).text ?? ""
        if (refText) parts.push(`[引用: ${refText}]`)
      }
    } else if (t === ITEM_VOICE) {
      const vt = (item.voice_item ?? {}).text ?? ""
      parts.push(vt || "[语音]")
    } else if (t === ITEM_IMAGE) {
      parts.push("[图片]")
    } else if (t === ITEM_VIDEO) {
      parts.push("[视频]")
    } else if (t === ITEM_FILE) {
      const fn = (item.file_item ?? {}).file_name ?? ""
      parts.push(fn ? `[文件: ${fn}]` : "[文件]")
    }
  }
  return parts.join(" ")
}

export function parseMessage(raw: dict): ParsedMessage | null {
  if ((raw.message_type ?? 0) === 2) return null
  const itemList = raw.item_list ?? []
  const fromUserId = raw.from_user_id ?? ""
  if (!itemList && !fromUserId) return null
  const text = extractText(itemList)
  return {
    conversation_id: fromUserId,
    text,
    message_id: String(raw.message_id ?? ""),
    context_token: raw.context_token ?? "",
    raw,
  }
}

// ── Send text ──────────────────────────────────────────────────────────────────

export async function sendText(
  baseUrl: string,
  token: string,
  convId: string,
  text: string,
  ctx: string,
): Promise<void> {
  const plain = stripMarkdown(text)
  const chunks = splitText(plain)
  for (const chunk of chunks) {
    await post(
      `${baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`,
      {
        msg: {
          from_user_id: "",
          to_user_id: convId,
          client_id: clientId(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: chunk } }],
          context_token: ctx,
        },
        base_info: baseInfo(),
      },
      token,
      10000,
    )
  }
}

// ── Send file ──────────────────────────────────────────────────────────────────

export async function sendFile(
  baseUrl: string,
  cdnBaseUrl: string,
  token: string,
  convId: string,
  filePath: string,
  ctx: string,
): Promise<void> {
  const info = await stat(filePath)
  if (info.size > 30 * 1024 * 1024) {
    console.error("[wechat] file too large:", filePath, info.size)
    return
  }
  const buf = await readFile(filePath)
  const key = crypto.randomBytes(16)
  const filekey = crypto.randomBytes(16).toString("hex")
  const file = mediaType(filePath)

  const uploadUrlResp = await post(
    `${baseUrl.replace(/\/$/, "")}/ilink/bot/getuploadurl`,
    {
      filekey,
      media_type: file.upload,
      to_user_id: convId,
      rawsize: buf.length,
      rawfilemd5: crypto.createHash("md5").update(buf).digest("hex"),
      filesize: aesSize(buf.length),
      no_need_thumb: true,
      aeskey: key.toString("hex"),
      base_info: baseInfo(),
    },
    token,
    10000,
  )

  const target =
    uploadUrlResp.upload_full_url?.trim() ||
    `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadUrlResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`

  const ciphertext = aesEnc(buf, key)

  const cdnRes = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  })
  if (cdnRes.status !== 200) {
    const raw = await cdnRes.text()
    throw new Error(`cdn ${cdnRes.status}: ${raw}`)
  }
  const param = cdnRes.headers.get("x-encrypted-param")
  if (!param) throw new Error("CDN upload missing x-encrypted-param")

  const aesBase64 = Buffer.from(key.toString("hex"), "utf-8").toString("base64")

  const item =
    file.kind === "image"
      ? {
          type: file.item,
          image_item: {
            media: { encrypt_query_param: param, aes_key: aesBase64, encrypt_type: 1 },
            mid_size: aesSize(buf.length),
          },
        }
      : file.kind === "video"
        ? {
            type: file.item,
            video_item: {
              media: { encrypt_query_param: param, aes_key: aesBase64, encrypt_type: 1 },
              video_size: aesSize(buf.length),
            },
          }
        : {
            type: file.item,
            file_item: {
              media: { encrypt_query_param: param, aes_key: aesBase64, encrypt_type: 1 },
              file_name: basename(filePath),
              len: String(buf.length),
            },
          }

  await post(
    `${baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`,
    {
      msg: {
        from_user_id: "",
        to_user_id: convId,
        client_id: clientId(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: ctx,
      },
      base_info: baseInfo(),
    },
    token,
    30000,
  )
}
