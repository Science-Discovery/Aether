import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Log } from "@/util/log"
import z from "zod"

const log = Log.create({ service: "session-task" })

export namespace SessionTask {
  export const Input = z.object({
    directory: z.string(),
    prompt: z.string(),
    title: z.string().optional(),
  })

  export const Output = z.object({
    sessionID: Session.Info.shape.id,
  })

  export type Input = z.infer<typeof Input>
  export type Output = z.infer<typeof Output>

  export async function start(raw: Input): Promise<Output> {
    const input = Input.parse(raw)
    return Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      async fn() {
        const session = await Session.create({
          title: input.title,
        })
        SessionPrompt.prompt({
          sessionID: session.id,
          parts: [
            {
              type: "text",
              text: input.prompt,
            },
          ],
        }).catch((error) => {
          log.error("session task failed", {
            sessionID: session.id,
            error,
          })
        })
        return {
          sessionID: session.id,
        }
      },
    })
  }
}
