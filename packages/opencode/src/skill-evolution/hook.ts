import { Counter } from "./counter"
import { ConfigReader } from "./config-reader"
import { isReviewSession, spawnReview } from "./review-agent"
import { Log } from "@/util/log"

const log = Log.create({ service: "skill-evolution.hook" })

export interface HookInput {
  readonly sessionID: string
  readonly isReviewSession: boolean
  readonly finalResponse: boolean
  readonly aborted: boolean
  /** Project ID of the session, used for AI-created skill routing. */
  readonly projectId: string
  /** Absolute path of the project directory — used to derive a human-readable folder name. */
  readonly projectDirectory?: string
}

export namespace SkillEvolutionHook {
  /**
   * Called once per LLM loop step (not per individual tool call).
   * Increments the per-session counter.
   * No-ops for review sessions (determined by the module-level registry).
   */
  export function onStep(sessionID: string): void {
    // Review sessions are excluded from counting to prevent recursive evolution
    if (isReviewSession(sessionID)) return
    Counter.increment(sessionID)
  }

  /**
   * Called once after the main LLM loop exits normally.
   * Checks all trigger conditions and spawns a background review if met.
   *
   * Trigger conditions (all must be true):
   *   ① counter ≥ threshold (default 10)
   *   ② finalResponse is true (loop produced an actual reply)
   *   ③ aborted is false (user did not cancel)
   *   ④ isReviewSession is false (prevent recursive spawning)
   */
  export async function onLoopEnd(input: HookInput): Promise<void> {
    if (input.aborted) return
    if (!input.finalResponse) return
    if (input.isReviewSession || isReviewSession(input.sessionID)) return

    const interval = await ConfigReader.getNudgeInterval().catch(() => 10)
    if (interval === 0) return

    const count = Counter.getAndReset(input.sessionID)
    if (count < interval) return

    log.info("triggering skill evolution review", {
      sessionID: input.sessionID,
      count,
      interval,
    })

    // Fire-and-forget — must not block or throw into the caller's scope
    spawnReview({
      sessionID: input.sessionID,
      projectId: input.projectId,
      projectDirectory: input.projectDirectory,
    }).catch((err) => {
      log.error("background review spawn error", { error: err })
    })
  }
}
