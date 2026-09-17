import { isUtf8 } from "node:buffer"
import { StringDecoder } from "node:string_decoder"
import { lazy } from "../util/lazy"
import { Process } from "../util/process"

export namespace ShellOutput {
  function codec(encoding: string) {
    try {
      return new TextDecoder(encoding)
    } catch {
      // Bun's supported legacy encodings vary by platform and version.
      return
    }
  }

  export function codepage(code: number) {
    const label =
      code >= 1250 && code <= 1258
        ? `windows-${code}`
        : (
            {
              866: "ibm866",
              874: "windows-874",
              932: "shift_jis",
              936: "gbk",
              949: "euc-kr",
              950: "big5",
              65001: "utf-8",
            } as Record<number, string | undefined>
          )[code]
    return label ? codec(label)?.encoding : undefined
  }

  export const encoding = lazy(async () => {
    if (process.platform !== "win32") return
    const result = await Process.text(["reg.exe", "query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage"], {
      abort: AbortSignal.timeout(3_000),
    }).catch(() => undefined)
    if (!result) return
    return (
      codepage(Number(result.text.match(/^\s+OEMCP\s+REG_SZ\s+(\d+)\s*$/im)?.[1])) ??
      codepage(Number(result.text.match(/^\s+ACP\s+REG_SZ\s+(\d+)\s*$/im)?.[1]))
    )
  })

  export function decoder(encoding?: string) {
    if (!encoding || encoding === "utf-8") return new StringDecoder("utf8")

    const native = codec(encoding)
    if (!native) return new StringDecoder("utf8")
    const pending: Buffer[] = []
    const flush = () => {
      if (!pending.length) return ""
      const chunk = Buffer.concat(pending)
      pending.length = 0
      return isUtf8(chunk) ? chunk.toString("utf8") : native.decode(chunk)
    }

    return {
      write(chunk: Buffer) {
        const output: string[] = []
        let start = 0
        for (let index = 0; index < chunk.length; index++) {
          if (chunk[index] !== 10 && chunk[index] !== 13) continue
          pending.push(chunk.subarray(start, index + 1))
          output.push(flush())
          start = index + 1
        }
        const tail = chunk.subarray(start)
        if (pending.length) {
          if (tail.length) pending.push(tail)
          return output.join("")
        }
        // ASCII is identical in both encodings; retain non-ASCII until the line is complete.
        const index = tail.findIndex((byte) => byte >= 128)
        if (index < 0) {
          output.push(tail.toString("ascii"))
          return output.join("")
        }
        output.push(tail.subarray(0, index).toString("ascii"))
        pending.push(tail.subarray(index))
        return output.join("")
      },
      end: flush,
    }
  }
}
