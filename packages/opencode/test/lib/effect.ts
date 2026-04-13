import { test, type TestOptions } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

const run = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) =>
  Effect.gen(function* () {
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  }).pipe(Effect.runPromise)

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, testLayer), opts)

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, testLayer), opts)

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, testLayer), opts)

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, liveLayer), opts)

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, liveLayer), opts)

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, liveLayer), opts)

  return { effect, live }
}

const env = TestConsole.layer
const clock = Layer.mergeAll(TestConsole.layer, TestClock.layer())

export const it = make(env, env)
export const clockIt = make(clock, env)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make(Layer.provideMerge(layer, env), Layer.provideMerge(layer, env))

export const testClockEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make(Layer.provideMerge(layer, clock), Layer.provideMerge(layer, env))
