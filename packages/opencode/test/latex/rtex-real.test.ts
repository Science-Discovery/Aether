import { expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { LatexRealtime } from "../../src/latex/rtex/session"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.RTEX_BIN

test.skipIf(!binary)("real rtex session starts with the local LuaLaTeX and emits layouts", async () => {
  await using dir = await tmpdir()
  await Bun.write(
    path.join(dir.path, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHello realtime world.\n\\end{document}\n",
  )
  await Instance.provide({
    directory: dir.path,
    fn: async () => {
      const opened = await LatexRealtime.open({
        root: ".",
        main: "main.tex",
        cfg: { rtex: { path: binary! } },
      })
      try {
        const session = LatexRealtime.get(opened.id)
        expect((await LatexRealtime.font(opened.id, undefined, "cmr10")).kind).toBe("type1")
        for (let index = 0; index < 600 && !session.events.some((event) => event.event === "LayoutUpdate"); index++)
          await Bun.sleep(100)
        expect(session.events.some((event) => event.event === "LayoutUpdate")).toBe(true)
        const text = "\\documentclass{article}\n\\begin{document}\nHello realtime world.\n\\end{document}\n"
        const at = text.indexOf("Hello")
        LatexRealtime.edit(opened.id, "main.tex", at, at, "Edited ")
        for (
          let index = 0;
          index < 300 &&
          !session.events.some((event) => event.event === "ParagraphUpdate" || event.event === "BackgroundScheduled");
          index++
        )
          await Bun.sleep(100)
        expect(
          session.events.some((event) => event.event === "ParagraphUpdate" || event.event === "BackgroundScheduled"),
        ).toBe(true)
      } finally {
        await LatexRealtime.close(opened.id)
      }
      await Instance.dispose()
    },
  })
})
