import { Counter } from "./counter"
import { DEFAULT_NUDGE_INTERVAL } from "./constants"
import { ConfigReader } from "./config-reader"
import { isReviewSession, spawnReview } from "./review-agent"
import { Log } from "@/util/log"
import { SessionID } from "@/session/schema"

const log = Log.create({ service: "skill-evolution.hook" })

export interface HookInput {
  readonly sessionID: SessionID
  readonly finalResponse: boolean
  readonly aborted: boolean
  /** Project ID of the session, used for AI-created skill routing. */
  readonly projectId: string
  /** Absolute path of the project directory — used to derive a human-readable folder name. */
  readonly projectDirectory?: string
}

export namespace SkillEvolutionHook {
  /**
   * Called once per tool-call step (after LLM responds with finish="tool-calls").
   * Resets then increments when skill_manage was called — mirrors Hermes L7868+L9110.
   * No-ops for review sessions (determined by Instance.directory).
   */
  export function onStep(sessionID: SessionID, calledSkillManage = false): void {
    // Review sessions are excluded from counting to prevent recursive evolution
    if (isReviewSession()) return
    if (calledSkillManage) Counter.reset(sessionID)
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
    if (isReviewSession()) return

    const interval = await ConfigReader.getNudgeInterval().catch(() => DEFAULT_NUDGE_INTERVAL)
    if (interval === 0) return

    const count = Counter.get(input.sessionID)
    if (count < interval) return

    log.info("triggering skill evolution review", {
      sessionID: input.sessionID,
      count,
      interval,
    })

    // Await spawn setup before resetting — counter survives if spawn fails early.
    // spawnReview catches all internal errors, so this never rejects.
    await spawnReview({
      sessionID: input.sessionID,
      projectId: input.projectId,
      projectDirectory: input.projectDirectory,
    })
    Counter.reset(input.sessionID)
  }
}
