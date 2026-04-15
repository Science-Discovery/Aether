import crypto from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const args = process.argv.slice(2)

const mime = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
} as const

const parse = () => {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i]
    const val = args[i + 1]
    if (!key?.startsWith("--") || val == null) continue
    out[key.slice(2)] = val
    i += 1
  }
  return out
}

const req = (opts: Record<string, string>, key: string) => {
  const val = opts[key]
  if (val) return val
  throw new Error(`Missing required arg: ${key}`)
}

const uin = () => Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64")

const aesSize = (n: number) => Math.ceil((n + 1) / 16) * 16

const enc = (buf: Buffer, key: Buffer) => {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(buf), cipher.final()])
}

const id = () => `aether-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`

const extMime = (file: string) =>
  mime[path.extname(file).toLowerCase() as keyof typeof mime] ?? "application/octet-stream"

const mediaType = (file: string) => {
  const type = extMime(file)
  if (type.startsWith("video/")) return { upload: 2, item: 5, kind: "video" as const }
  if (type.startsWith("image/")) return { upload: 1, item: 2, kind: "image" as const }
  return { upload: 3, item: 4, kind: "file" as const }
}

const VERSION = "2.1.8"
const APP_ID = "bot"
const cvNum = ((2 & 0xff) << 16) | ((1 & 0xff) << 8) | (8 & 0xff)

const post = async (url: string, body: unknown, token?: string) => {
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
  if (!res.ok) throw new Error(`${res.status}: ${raw}`)
  return raw ? JSON.parse(raw) : {}
}

const upload = async (opts: Record<string, string>, filePath: string) => {
  const buf = await readFile(filePath)
  const key = crypto.randomBytes(16)
  const filekey = crypto.randomBytes(16).toString("hex")
  const file = mediaType(filePath)

  const uploadUrlResp = await post(
    `${req(opts, "base-url").replace(/\/$/, "")}/ilink/bot/getuploadurl`,
    {
      filekey,
      media_type: file.upload,
      to_user_id: req(opts, "chat-id"),
      rawsize: buf.length,
      rawfilemd5: crypto.createHash("md5").update(buf).digest("hex"),
      filesize: aesSize(buf.length),
      no_need_thumb: true,
      aeskey: key.toString("hex"),
      base_info: { channel_version: VERSION },
    },
    req(opts, "token"),
  )

  const target =
    uploadUrlResp.upload_full_url?.trim() ||
    `${req(opts, "cdn-base-url")}/upload?encrypted_query_param=${encodeURIComponent(uploadUrlResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`

  const ciphertext = enc(buf, key)

  const res = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  })
  const raw = await res.text()
  if (res.status !== 200) throw new Error(`cdn ${res.status}: ${raw}`)
  const param = res.headers.get("x-encrypted-param")
  if (!param) throw new Error("CDN upload response missing x-encrypted-param header")

  const aesBase64 = Buffer.from(key.toString("hex"), "utf-8").toString("base64")

  return {
    file,
    query: param,
    aes: aesBase64,
    size: buf.length,
    cipher: aesSize(buf.length),
    name: path.basename(filePath),
  }
}

const send = async (opts: Record<string, string>, media: Awaited<ReturnType<typeof upload>>) => {
  const item =
    media.file.kind === "image"
      ? {
          type: media.file.item,
          image_item: {
            media: { encrypt_query_param: media.query, aes_key: media.aes, encrypt_type: 1 },
            mid_size: media.cipher,
          },
        }
      : media.file.kind === "video"
        ? {
            type: media.file.item,
            video_item: {
              media: { encrypt_query_param: media.query, aes_key: media.aes, encrypt_type: 1 },
              video_size: media.cipher,
            },
          }
        : {
            type: media.file.item,
            file_item: {
              media: { encrypt_query_param: media.query, aes_key: media.aes, encrypt_type: 1 },
              file_name: media.name,
              len: String(media.size),
            },
          }

  const body = {
    msg: {
      from_user_id: "",
      to_user_id: req(opts, "chat-id"),
      client_id: id(),
      message_type: 2,
      message_state: 2,
      item_list: [item],
      context_token: req(opts, "context-token"),
    },
    base_info: { channel_version: VERSION },
  }

  await post(`${req(opts, "base-url").replace(/\/$/, "")}/ilink/bot/sendmessage`, body, req(opts, "token"))
}

const main = async () => {
  const opts = parse()
  const filePath = path.resolve(req(opts, "file"))
  const media = await upload(opts, filePath)
  await send(opts, media)
  process.stdout.write(JSON.stringify({ ok: true, filePath }) + "\n")
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`)
  process.exit(1)
})
