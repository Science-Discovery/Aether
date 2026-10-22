import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { importSessionBackup } from "../../src/session/backup"
import { Log } from "../../src/util/log"
import * as claude from "../../src/migrate/adapters/claude"
import * as codex from "../../src/migrate/adapters/codex"
import * as codebuddy from "../../src/migrate/adapters/codebuddy"
import * as copilot from "../../src/migrate/adapters/copilot"
import * as grok from "../../src/migrate/adapters/grok"
import * as kimi from "../../src/migrate/adapters/kimi"
import * as muse from "../../src/migrate/adapters/muse"
import * as omp from "../../src/migrate/adapters/omp"
import * as opencode from "../../src/migrate/adapters/opencode"
import * as openhands from "../../src/migrate/adapters/openhands"
import * as pi from "../../src/migrate/adapters/pi"
import * as qoder from "../../src/migrate/adapters/qoder"
import * as qodercn from "../../src/migrate/adapters/qodercn"
import * as qwen from "../../src/migrate/adapters/qwen"
import * as vibe from "../../src/migrate/adapters/vibe"
import { buildBackup } from "../../src/migrate/target"
import type { ParsedSession } from "../../src/migrate/model"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const fixture = (file: string) => path.join(import.meta.dir, "fixtures", file)

type Case = {
  name: string
  file: string
  parse: (path: string) => Promise<ParsedSession>
  title: string
  marker: string
  messages: number
  compaction?: boolean
  image?: boolean
}

const cases: Case[] = [
  {
    name: "claude",
    file: "claude/basic.jsonl",
    parse: claude.parse,
    title: "Remember synthetic migrator nonce ALPHA-1042.",
    marker: "ALPHA-1042",
    messages: 7,
    compaction: true,
    image: true,
  },
  {
    name: "codex",
    file: "codex/basic.jsonl",
    parse: codex.parse,
    title: "Remember synthetic migrator nonce BETA-2048.",
    marker: "BETA-2048",
    messages: 7,
    compaction: true,
    image: true,
  },
  {
    name: "pi",
    file: "pi/basic.jsonl",
    parse: pi.parse,
    title: "SYNTHETIC_IMPORTED_NAME",
    marker: "SYNTHETIC_USER_MARKER",
    messages: 3,
    image: true,
  },
  {
    name: "copilot",
    file: "copilot/events.jsonl",
    parse: copilot.parse,
    title: "SYNTHETIC_COPILOT_SOURCE_TITLE",
    marker: "SYNTHETIC_COPILOT_SOURCE_USER",
    messages: 5,
    compaction: true,
    image: true,
  },
  {
    name: "opencode",
    file: "opencode/basic.json",
    parse: opencode.parse,
    title: "SYNTHETIC_IMPORTED_NAME",
    marker: "SYNTHETIC_USER_MARKER",
    messages: 3,
    image: true,
  },
  {
    name: "opencode-comprehensive",
    file: "opencode/comprehensive.json",
    parse: opencode.parse,
    title: "SYNTHETIC_OPENCODE_SOURCE_TITLE",
    marker: "SYNTHETIC_OPENCODE_USER_MARKER",
    messages: 4,
    compaction: true,
    image: true,
  },
  {
    name: "omp",
    file: "omp/basic.jsonl",
    parse: omp.parse,
    title: "OMP synthetic fixture",
    marker: "OMP_SYNTHETIC_USER_ALPHA",
    messages: 6,
    compaction: true,
    image: true,
  },
  {
    name: "qwen",
    file: "qwen/basic.jsonl",
    parse: qwen.parse,
    title: "@assets/corpus-card.png We are testing a disposable timeline helper.",
    marker: "SM_CORPUS_7319",
    messages: 3,
  },
  {
    name: "kimi",
    file: "kimi/session_0e9113f5-23d9-4ad4-8a94-a3f44c175d14",
    parse: kimi.parse,
    title: "We are testing a disposable timeline helper.",
    marker: "SM_CORPUS_7319",
    messages: 5,
  },
  {
    name: "vibe",
    file: "vibe/basic",
    parse: vibe.parse,
    title: "Synthetic Vibe fixture",
    marker: "ALPHA-1042",
    messages: 7,
    compaction: true,
    image: true,
  },
  {
    name: "muse",
    file: "muse/session.jsonl",
    parse: muse.parse,
    title: "SM_CORPUS_7319",
    marker: "SM_CORPUS_7319",
    messages: 9,
  },
  {
    name: "grok",
    file: "grok/session",
    parse: grok.parse,
    title: "repair-event-window-boundary",
    marker: "repair-event-window-boundary",
    messages: 9,
  },
  {
    name: "qoder",
    file: "qoder/basic.jsonl",
    parse: qoder.parse,
    title: "QODER_TITLE",
    marker: "QODER_USER_MARKER",
    messages: 2,
  },
  {
    name: "qodercn",
    file: "qodercn/basic.jsonl",
    parse: qodercn.parse,
    title: "QODERCN_TITLE",
    marker: "QODERCN_USER_MARKER",
    messages: 2,
  },
  {
    name: "codebuddy",
    file: "codebuddy/basic.jsonl",
    parse: codebuddy.parse,
    title: "CODEBUDDY_TITLE",
    marker: "CODEBUDDY_USER_MARKER",
    messages: 5,
    compaction: true,
  },
  {
    name: "openhands",
    file: "openhands/99e61c51f6e945cc93b022fee3a459f4",
    parse: openhands.parse,
    title:
      "repair-event-window-boundary: remember SM_CORPUS_7319, inspect timeline.py and CORPUS_NOTE.txt with the native terminal tool, explain the boundary bug briefly, and do not edit files.",
    marker: "SM_CORPUS_7319",
    messages: 3,
  },
]

describe("Aether target writer", () => {
  test("imports every supported fixture through importSessionBackup", async () => {
    await using dir = await tmpdir({ git: true })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        for (const item of cases) {
          const source = await item.parse(fixture(item.file))
          const built = buildBackup(source, { directory: dir.path })
          expect(built.manifest.warnings).toEqual([])
          const imported = await importSessionBackup(built.backup)
          expect(imported.title.startsWith(item.title)).toBe(true)
          const messages = await Session.messages({ sessionID: imported.sessionID })
          expect(messages.length).toBe(item.messages)
          expect(messages[0]?.info.role).toBe("user")

          const ids = new Set(messages.map((message) => message.info.id))
          for (const message of messages) {
            if (message.info.role !== "assistant") continue
            expect(ids.has(message.info.parentID)).toBe(true)
          }

          const text = messages[0]?.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          expect(text).toContain(item.marker)

          for (const message of messages) {
            const tools = message.parts.filter((part) => part.type === "tool")
            for (const tool of tools) {
              expect(tool.state.status === "completed" || tool.state.status === "error").toBe(true)
            }
          }

          if (item.image) {
            expect(
              messages.some((message) => message.parts.some((part) => part.type === "file" && part.mime.startsWith("image/"))),
            ).toBe(true)
          }
          if (item.compaction) {
            expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(true)
            expect(
              messages.some((message) => message.info.role === "assistant" && message.info.summary === true),
            ).toBe(true)
          }
        }
      },
    })
  })
})
