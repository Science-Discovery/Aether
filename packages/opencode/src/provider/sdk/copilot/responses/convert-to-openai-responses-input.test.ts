import { describe, expect, test } from "bun:test"
import { convertToOpenAIResponsesInput } from "./convert-to-openai-responses-input"

describe("convertToOpenAIResponsesInput", () => {
  test("passes through normalized data URLs for pdf file parts", async () => {
    const result = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "excerpt.pdf",
              data: "data:text/html;base64,JVBERi0xLjQK",
            },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "excerpt.pdf",
            file_data: "JVBERi0xLjQK",
          },
        ],
      },
    ])
  })
})
