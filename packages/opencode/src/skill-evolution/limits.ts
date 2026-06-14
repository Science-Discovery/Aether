/**
 * Cost guards for background skill-evolution reviews.
 *
 * Background reviews run fire-and-forget via SessionPrompt.prompt, which loops
 * the model through tool calls until it decides to stop. The default `build`
 * agent sets no `steps`, so that loop is uncapped (maxSteps = Infinity) — a
 * runaway model can loop forever and burn tokens unseen. Two character caps
 * bound a single review: a per-step cap cuts a step that never stops emitting,
 * and a whole-review cap stops a "slow grind" that never stops taking steps.
 * Both are empirical defaults, not measured from real review distributions;
 * raise them if reviews get killed too often (visible as reviews silently
 * producing no result).
 */

/**
 * Max characters a SINGLE step may stream out before that step is cut off
 * mid-flight.
 *
 * The runaway bug we guard against is a model that never stops emitting within
 * ONE step — the step never finishes, so neither the step cap (counted between
 * steps) nor any token total (only known once a step finishes) can catch it.
 * The only signal available mid-stream is the text itself, so we count
 * characters as a proxy for tokens (~4 chars/token). 300k chars (~75k tokens)
 * is far beyond any sane single step's output; only a runaway loop reaches it.
 */
export const REVIEW_MAX_STEP_CHARS = 300_000

/**
 * Max characters a WHOLE review may stream out (summed across every step)
 * before the entire review is stopped.
 *
 * This is the second guard: a model that emits a sane amount per step but never
 * stops taking steps ("slow grind") would slip past the single-step cap. The
 * total is just the per-step character counts accumulated across the run, so
 * both caps share one count. 1M chars (~250k tokens) leaves room for a normal
 * review to read a diff, open several files and write its findings; only a
 * grinding loop reaches it.
 */
export const REVIEW_MAX_TOTAL_CHARS = 1_000_000

/**
 * Whether a streamed character count has passed its cap — the model is running
 * away. Used for both guards: pass the single-step count against
 * REVIEW_MAX_STEP_CHARS, or the whole-review count against
 * REVIEW_MAX_TOTAL_CHARS. Equal to the cap is still allowed; only strictly
 * greater is runaway.
 */
export function isOutputRunaway(accumulatedChars: number, max: number): boolean {
  return accumulatedChars > max
}

/**
 * Resolve the two character caps for a review from config, falling back to the
 * constant defaults when a field is unset.
 *
 * The `??` (not `||`) is deliberate: a user may set a cap to 0 to mean "cap at
 * zero", which is falsy — `||` would wrongly treat it as missing and restore the
 * default. Only an actually-absent field (null/undefined) should fall back.
 *
 * Shape is intentionally loose (just the two fields we read) so callers can pass
 * the whole Config without this module depending on the full Config type.
 */
export function reviewCharLimits(config?: {
  skills?: { review_max_step_chars?: number; review_max_total_chars?: number }
}): { stepMax: number; totalMax: number } {
  return {
    stepMax: config?.skills?.review_max_step_chars ?? REVIEW_MAX_STEP_CHARS,
    totalMax: config?.skills?.review_max_total_chars ?? REVIEW_MAX_TOTAL_CHARS,
  }
}

/** What the processor should do after streaming the latest chunk of a review. */
export type ReviewCharAction = "continue" | "stop-review"

/**
 * Single decision point for the two character guards a background review runs.
 * Both guards share one running count: `stepChars` resets every step,
 * `totalChars` accumulates across the whole review.
 *
 * Either guard tripping ends the WHOLE review ("stop-review"):
 * - total over its cap → slow grind: sane per step, but never stops stepping.
 * - step over its cap → one-shot runaway: never stops emitting within one step.
 *
 * (Earlier this only cut the offending step and kept going, but a step that
 * keeps getting cut just spins forever producing nothing — so a tripped step
 * cap now stops the review too.)
 *
 * - else → "continue".
 */
export function reviewCharGuard(
  usage: { stepChars: number; totalChars: number },
  caps: { stepMax: number; totalMax: number },
): ReviewCharAction {
  if (isOutputRunaway(usage.totalChars, caps.totalMax)) return "stop-review"
  if (isOutputRunaway(usage.stepChars, caps.stepMax)) return "stop-review"
  return "continue"
}

/**
 * Stateful char accountant for one background review. The whole-review total
 * lives here so it survives across steps — the processor is rebuilt every step
 * and must NOT own this count, or the slow-grind guard never accumulates.
 *
 * Usage: the outer loop creates ONE counter per review (outside the per-step
 * loop), calls `stepReset()` at the start of each step, then `record(n)` for
 * each streamed chunk; `record` returns the guard action for that chunk.
 */
export function createReviewCharCounter(caps: { stepMax: number; totalMax: number }) {
  let total = 0
  let step = 0
  return {
    /** Zero the per-step count at the start of a step; the whole-review total is
     *  left untouched so it keeps accumulating across steps. */
    stepReset() {
      step = 0
    },
    /** Record `n` streamed chars; returns "continue" or "stop-review" per the
     *  per-step and whole-review caps. */
    record(n: number): ReviewCharAction {
      step += n
      total += n
      return reviewCharGuard({ stepChars: step, totalChars: total }, caps)
    },
    get total() {
      return total
    },
    get step() {
      return step
    },
  }
}
