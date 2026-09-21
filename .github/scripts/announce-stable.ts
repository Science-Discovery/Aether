const siteBase = env("SITE_BASE").replace(/\/+$/, "")
const siteKey = env("SITE_API_KEY")
const ver = env("VERSION")
const releaseBody = process.env.RELEASE_BODY?.trim() || ""
const titleZhInput = process.env.TITLE_ZH?.trim() || ""
const titleEnInput = process.env.TITLE_EN?.trim() || ""
const summaryZhInput = process.env.SUMMARY_ZH?.trim() || ""
const summaryEnInput = process.env.SUMMARY_EN?.trim() || ""

function env(key: string) {
  return process.env[key]?.trim() || fail(`Missing ${key}`)
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const line = cut.lastIndexOf("\n")
  return line > max / 2 ? cut.slice(0, line) : cut.replace(/\s+\S*$/, "")
}

function cleanBody(body: string) {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function asciiRatio(text: string) {
  if (text.length === 0) return 0
  const ascii = [...text].filter((ch) => ch.charCodeAt(0) < 128).length
  return ascii / text.length
}

async function main() {
  const list = await fetch(`${siteBase}/v1/announcements?lang=zh-cn&limit=50`)
  if (!list.ok) fail(`Failed to list announcements: ${list.status}`)
  const items = ((await list.json()) as { data?: Array<{ version?: string }> }).data ?? []
  if (items.some((item) => item.version === ver)) {
    console.log(`Announcement for ${ver} already exists, skip`)
    return
  }

  const body = cleanBody(releaseBody)
  const lines = body.split("\n").filter((line) => line.length > 0)
  const titleZh = titleZhInput || truncate(lines[0] ?? `Aether v${ver} 发布`, 80)
  const summaryZh = summaryZhInput || truncate(body || `Aether v${ver} 发布`, 500)
  const useEn = asciiRatio(body) >= 0.6
  const titleEn = titleEnInput || (useEn ? truncate(lines[0] ?? "", 120) : "")
  const summaryEn = summaryEnInput || (useEn ? truncate(body, 800) : "")

  const payload: Record<string, unknown> = {
    version: ver,
    published_date: new Date().toISOString().slice(0, 10),
    type: "release",
    title_zh: titleZh,
    summary_zh: summaryZh,
    status: "online",
  }
  if (titleEn) payload.title_en = titleEn
  if (summaryEn) payload.summary_en = summaryEn

  const res = await fetch(`${siteBase}/v1/admin/announcements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${siteKey}`,
    },
    body: JSON.stringify(payload),
  })
  if (res.status === 401 || res.status === 403) {
    fail(`Announcement rejected (${res.status}): check SITE_ANNOUNCE_API_KEY is an admin account key`)
  }
  if (!res.ok) fail(`Failed to create announcement: ${res.status} ${await res.text().catch(() => "")}`)
  const created = (await res.json().catch(() => fail("Invalid announcement response"))) as { data?: { id?: string } }
  console.log(`Created announcement ${created.data?.id ?? ""} for ${ver}: ${titleZh}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
