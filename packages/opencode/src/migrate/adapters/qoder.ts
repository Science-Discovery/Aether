import * as claude from "./claude"

export async function parse(path: string) {
  return { ...(await claude.parse(path)), source: "qoder" as const }
}
