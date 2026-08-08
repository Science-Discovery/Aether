import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"

const sessionID = SessionID.make("session_mineru")
const messageID = MessageID.make("message_mineru")
const model = {
  id: "text-model",
  providerID: "test",
  api: { id: "text-model", npm: "@ai-sdk/openai-compatible" },
} as Provider.Model

describe("session.message-v2 MinerU parts", () => {
  test("keeps extracted text while omitting the ignored source attachment", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 0 },
          agent: "user",
          model: { providerID: "test", modelID: "text-model" },
          tools: {},
        } as MessageV2.User,
        parts: [
          {
            id: PartID.make("text_mineru"),
            sessionID,
            messageID,
            type: "text",
            text: "extracted markdown",
          },
          {
            id: PartID.make("file_mineru"),
            sessionID,
            messageID,
            type: "file",
            mime: "application/pdf",
            filename: "source.pdf",
            url: "data:application/pdf;base64,JVBERg==",
            ignored: true,
          },
        ],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "extracted markdown" }],
      },
    ])
  })
})
