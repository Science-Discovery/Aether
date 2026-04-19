import { describe, expect, test } from "bun:test"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"

const model = {
  id: "gpt-5.4",
  providerID: "openai",
  api: {
    npm: "@ai-sdk/openai",
    id: "gpt-5.4",
    type: "responses",
  },
} as unknown as Provider.Model

describe("MessageV2.toModelMessages", () => {
  test("downgrades unsupported user file parts into text placeholders", () => {
    const result = MessageV2.toModelMessages(
      [
        {
          info: {
            id: "message_1" as any,
            sessionID: "session_1" as any,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: {
              providerID: "openai" as any,
              modelID: "gpt-5.4" as any,
            },
          },
          parts: [
            {
              id: "part_1" as any,
              sessionID: "session_1" as any,
              messageID: "message_1" as any,
              type: "file",
              mime: "text/html",
              filename: "error.html",
              url: "data:text/html;base64,PGh0bWw+",
            },
          ],
        },
      ],
      model,
    )

    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[Attached unsupported file omitted: error.html (text/html)]",
          },
        ],
      },
    ])
  })

  test("normalizes mismatched data url mime prefixes for supported user files", () => {
    const result = MessageV2.toModelMessages(
      [
        {
          info: {
            id: "message_2" as any,
            sessionID: "session_1" as any,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: {
              providerID: "openai" as any,
              modelID: "gpt-5.4" as any,
            },
          },
          parts: [
            {
              id: "part_2" as any,
              sessionID: "session_1" as any,
              messageID: "message_2" as any,
              type: "file",
              mime: "application/pdf",
              filename: "excerpt.pdf",
              url: "data:text/html;base64,JVBERi0xLjQK",
            },
          ],
        },
      ],
      model,
    )

    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            filename: "excerpt.pdf",
            mediaType: "application/pdf",
            data: "data:application/pdf;base64,JVBERi0xLjQK",
          },
        ],
      },
    ])
  })
})
