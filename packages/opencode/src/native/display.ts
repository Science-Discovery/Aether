import { MessageID } from "@/session/schema"

/** Display segments share one native turn; their IDs do not create new runs. */
export namespace NativeDisplay {
  export function id(parent: MessageID | string) {
    return MessageID.make(`${parent}_codex`)
  }
}
