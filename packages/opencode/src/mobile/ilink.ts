import crypto from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { basename, extname } from "node:path"

const VERSION = "2.1.8"
const APP_ID = "bot"
const cvNum = ((2 & 0xff) << 16) | ((1 & 0xff) << 8) | (8 & 0xff)

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

const id = () => `aether-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`

const aesSize = (n: number) => Math.ceil((n + 1) / 16) * 16

const aesEnc = (buf: Buffer, key: Buffer) => {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(buf), cipher.final()])
}

async function post(url: string, body: unknown, token?: string) {
  const text = JSON.stringify(body)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(text, "utf-8")),
      "X-WECHAT-UIN": uin(),
      "iLink-App-Id": APP_ID,
      "iLink-App-ClientVersion": String(cvNum),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: text,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`ilink ${res.status}: ${raw}`)
  return raw ? JSON.parse(raw) : {}
}

export async function sendText(
  baseUrl: string,
  token: string,
  convId: string,
  text: string,
  ctx: string,
): Promise<void> {
  await post(
    `${baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`,
    {
      msg: {
        from_user_id: "",
        to_user_id: convId,
        client_id: id(),
        message_type: 1,
        message_state: 2,
        text_item: { text },
        context_token: ctx,
      },
      base_info: { channel_version: VERSION },
    },
    token,
  )
}

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
      base_info: { channel_version: VERSION },
    },
    token,
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
        client_id: id(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: ctx,
      },
      base_info: { channel_version: VERSION },
    },
    token,
  )
}
