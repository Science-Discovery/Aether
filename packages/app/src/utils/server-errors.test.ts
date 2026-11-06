import { describe, expect, test } from "bun:test"
import type { ConfigInvalidError, ProviderModelNotFoundError } from "./server-errors"
import { formatServerError, parseReadableConfigInvalidError } from "./server-errors"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { dict as zht } from "@/i18n/zht"

describe("session split errors", () => {
  test("translates busy, task-session and changed-tree failures in all three supported dictionaries", () => {
    for (const dict of [en, zh, zht] as Record<string, string>[]) {
      const translate = (key: string) => dict[key] ?? key
      expect(
        formatServerError({ name: "SessionBusyError", data: { message: "Session child is busy" } }, translate),
      ).toBe(dict["error.chain.session.busy"])
      expect(
        formatServerError(
          { name: "SessionDetachError", data: { message: "Task subagent sessions cannot be detached." } },
          translate,
        ),
      ).toBe(dict["error.chain.session.detachTask"])
      for (const action of ["forking", "detaching"]) {
        expect(
          formatServerError(
            { name: "SessionDetachError", data: { message: `Session tree changed while ${action}. Please retry.` } },
            translate,
          ),
        ).toBe(dict["error.chain.session.treeChanged"])
      }
    }
  })
})

function fill(text: string, vars?: Record<string, string | number>) {
  if (!vars) return text
  return text.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) return ""
    return String(value)
  })
}

function useLanguageMock() {
  const dict: Record<string, string> = {
    "error.chain.unknown": "Erro desconhecido",
    "error.chain.configInvalid": "Arquivo de config em {{path}} invalido",
    "error.chain.configInvalidWithMessage": "Arquivo de config em {{path}} invalido: {{message}}",
    "error.chain.modelNotFound": "Modelo nao encontrado: {{provider}}/{{model}}",
    "error.chain.didYouMean": "Voce quis dizer: {{suggestions}}",
    "error.chain.checkConfig": "Revise provider/model no config",
    "prompt.model.required": "Conecte um provedor e selecione um modelo.",
    "error.network.failedToFetch": "Falha de rede",
  }
  return {
    t(key: string, vars?: Record<string, string | number>) {
      const text = dict[key]
      if (!text) return key
      return fill(text, vars)
    },
  }
}

const language = useLanguageMock()

describe("parseReadableConfigInvalidError", () => {
  test("formats issues with file path", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        path: "opencode.config.ts",
        issues: [
          { path: ["settings", "host"], message: "Required" },
          { path: ["mode"], message: "Invalid" },
        ],
      },
    } satisfies ConfigInvalidError

    const result = parseReadableConfigInvalidError(error, language.t)

    expect(result).toBe(
      ["Arquivo de config em opencode.config.ts invalido: settings.host: Required", "mode: Invalid"].join("\n"),
    )
  })

  test("uses trimmed message when issues are missing", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        path: "config",
        message: "  Bad value  ",
      },
    } satisfies ConfigInvalidError

    const result = parseReadableConfigInvalidError(error, language.t)

    expect(result).toBe("Arquivo de config em config invalido: Bad value")
  })
})

describe("formatServerError", () => {
  test("shows a localized setup instruction for an unconfigured model", () => {
    const error = { name: "NoModelConfiguredError", data: { message: "No models available" } }
    expect(formatServerError(error, language.t)).toBe("Conecte um provedor e selecione um modelo.")
    expect(formatServerError(error)).toBe("Connect a provider and select a model first.")
    expect(formatServerError(error, (key) => key)).toBe("Connect a provider and select a model first.")
  })
  test("formats config invalid errors", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        message: "Missing host",
      },
    } satisfies ConfigInvalidError

    const result = formatServerError(error, language.t)

    expect(result).toBe("Arquivo de config em config invalido: Missing host")
  })

  test("returns error messages", () => {
    expect(formatServerError(new Error("Request failed with status 503"), language.t)).toBe(
      "Request failed with status 503",
    )
  })

  test("returns provided string errors", () => {
    expect(formatServerError("Failed to connect to server", language.t)).toBe("Failed to connect to server")
  })

  test("surfaces LaTeX HTTP errors parsed by the SDK", () => {
    const error: unknown = JSON.parse(
      '{"error":"The LaTeX project exceeds 256 MiB. Choose a smaller project directory."}',
    )
    expect(formatServerError(error, language.t)).toBe(
      "The LaTeX project exceeds 256 MiB. Choose a smaller project directory.",
    )
  })

  test("handles plain server messages without stringifying unrelated payloads", () => {
    expect(formatServerError({ message: "  Source file is missing.  " }, language.t)).toBe("Source file is missing.")
    expect(formatServerError({ error: { code: 413 } }, language.t)).toBe("Erro desconhecido")
    expect(formatServerError({ error: "   " }, language.t, "Try again")).toBe("Try again")
  })

  test("preserves error and message fields returned as JSON objects", () => {
    const missing: unknown = JSON.parse('{"error":"File not found"}')
    const denied: unknown = JSON.parse('{"message":"Access denied: path escapes project directory"}')
    expect(formatServerError(missing, language.t)).toBe("File not found")
    expect(formatServerError(denied, language.t)).toBe("Access denied: path escapes project directory")
    expect(formatServerError({ error: "  ", message: "Missing image" }, language.t)).toBe("Missing image")
  })

  test("translates network messages in JSON errors without exposing unrelated fields", () => {
    const error: unknown = JSON.parse(
      '{"error":"Failed to fetch\\n    at fetch (private.js)","stack":"private stack","body":"private body"}',
    )
    expect(formatServerError(error, language.t)).toBe("Falha de rede")
    expect(formatServerError({ error: { body: "private body" }, stack: "private stack" }, language.t)).toBe(
      "Erro desconhecido",
    )
  })

  test("keeps named and configuration errors ahead of generic JSON messages", () => {
    expect(
      formatServerError(
        { name: "UnknownError", data: { message: "Named reason" }, error: "Generic reason" },
        language.t,
      ),
    ).toBe("Named reason")
    expect(
      formatServerError(
        { name: "ConfigInvalidError", data: { message: "Missing host" }, message: "Generic reason" },
        language.t,
      ),
    ).toBe("Arquivo de config em config invalido: Missing host")
  })

  test("uses translated unknown fallback", () => {
    expect(formatServerError(0, language.t)).toBe("Erro desconhecido")
  })

  test("falls back for unknown error objects and names", () => {
    expect(formatServerError({ name: "ServerTimeoutError", data: { seconds: 30 } }, language.t)).toBe(
      "Erro desconhecido",
    )
  })

  test("surfaces the first line of a named error's data message", () => {
    const error = {
      name: "UnknownError",
      data: {
        message: "EACCES: permission denied, rm 'dir' failed\n    at async rm (node:fs)\n    at ...",
      },
    }
    expect(formatServerError(error, language.t)).toBe("EACCES: permission denied, rm 'dir' failed")
  })

  test("ignores non-string data messages", () => {
    expect(formatServerError({ name: "UnknownError", data: { message: { code: 7 } } }, language.t)).toBe(
      "Erro desconhecido",
    )
  })

  test("formats provider model errors using provider/model", () => {
    const error = {
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "openai",
        modelID: "gpt-4.1",
      },
    } satisfies ProviderModelNotFoundError

    expect(formatServerError(error, language.t)).toBe(
      ["Modelo nao encontrado: openai/gpt-4.1", "Revise provider/model no config"].join("\n"),
    )
  })

  test("formats provider model suggestions", () => {
    const error = {
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "x",
        modelID: "y",
        suggestions: ["x/y2", "x/y3"],
      },
    } satisfies ProviderModelNotFoundError

    expect(formatServerError(error, language.t)).toBe(
      ["Modelo nao encontrado: x/y", "Voce quis dizer: x/y2, x/y3", "Revise provider/model no config"].join("\n"),
    )
  })
})
