import { describe, expect, test } from "bun:test"
import { ShellOutput } from "../../src/shell/output"

const native = Buffer.from([0xce, 0xbb, 0xd6, 0xc3, 0xd6, 0xd0, 0xce, 0xc4]) // 位置中文 in CP936

describe("shell.output", () => {
  test.each(Array.from({ length: native.length + 1 }, (_, index) => index))(
    "decodes CP936 split at byte %i",
    (index) => {
      const decoder = ShellOutput.decoder("gbk")
      expect(decoder.write(native.subarray(0, index)) + decoder.write(native.subarray(index)) + decoder.end()).toBe(
        "位置中文",
      )
    },
  )

  test.each([undefined, "utf-8", "gbk"])("preserves split UTF-8 with fallback %s", (encoding) => {
    const data = Buffer.from("位置中文🙂\r\n")
    for (let index = 0; index <= data.length; index++) {
      const decoder = ShellOutput.decoder(encoding)
      expect(decoder.write(data.subarray(0, index)) + decoder.write(data.subarray(index)) + decoder.end()).toBe(
        "位置中文🙂\r\n",
      )
    }
  })

  test("decodes adjacent UTF-8 and CP936 lines independently", () => {
    const decoder = ShellOutput.decoder("gbk")
    const data = Buffer.concat([Buffer.from("中文🙂\n"), native, Buffer.from("\n中文🙂\n"), native])
    expect(Array.from(data, (byte) => decoder.write(Buffer.from([byte]))).join("") + decoder.end()).toBe(
      "中文🙂\n位置中文\n中文🙂\n位置中文",
    )
  })

  test("flushes carriage-return progress without waiting for a newline", () => {
    const decoder = ShellOutput.decoder("gbk")
    expect(decoder.write(native)).toBe("")
    expect(decoder.write(Buffer.from(" 50%\r"))).toBe("位置中文 50%\r")
    expect(decoder.write(Buffer.concat([native, Buffer.from(" 100%\r\n")]))).toBe("位置中文 100%\r\n")
    expect(decoder.end()).toBe("")
  })

  test("emits ASCII immediately before buffering a non-ASCII tail", () => {
    const decoder = ShellOutput.decoder("gbk")
    expect(decoder.write(Buffer.from("building "))).toBe("building ")
    expect(decoder.write(Buffer.concat([Buffer.from("file: "), native]))).toBe("file: ")
    expect(decoder.write(Buffer.from("..."))).toBe("")
    expect(decoder.end()).toBe("位置中文...")
    expect(decoder.end()).toBe("")
  })

  test("preserves incomplete UTF-8 at stream end with the standard decoder", () => {
    const decoder = ShellOutput.decoder()
    expect(decoder.write(Buffer.from([0xe4, 0xb8]))).toBe("")
    expect(decoder.end()).toBe("�")
  })

  test.each([
    [866, "ibm866"],
    [874, "windows-874"],
    [932, "shift_jis"],
    [936, "gbk"],
    [949, "euc-kr"],
    [950, "big5"],
    [1252, "windows-1252"],
    [1257, "windows-1257"],
    [65001, "utf-8"],
  ] as const)("maps supported Windows code page %i", (code, encoding) => {
    expect(ShellOutput.codepage(code)).toBe(encoding)
    expect(ShellOutput.decoder(encoding).write(Buffer.from("ASCII\n"))).toBe("ASCII\n")
  })

  test("leaves unsupported Windows code pages unresolved", () => {
    expect(ShellOutput.codepage(437)).toBeUndefined()
    expect(ShellOutput.codepage(850)).toBeUndefined()
    expect(ShellOutput.codepage(0)).toBeUndefined()
    expect(ShellOutput.codepage(Number.NaN)).toBeUndefined()
  })

  test("falls back to UTF-8 when the encoding is unsupported", () => {
    const decoder = ShellOutput.decoder("unsupported")
    expect(decoder.write(Buffer.from("中文🙂"))).toBe("中文🙂")
    expect(decoder.end()).toBe("")
  })
})
