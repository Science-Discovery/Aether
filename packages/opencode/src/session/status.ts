import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { SessionID } from "./schema"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { registerDisposer } from "@/effect/instance-registry"
import { Instance } from "@/project/instance"

export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
      z.object({
        type: z.literal("busy"),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: SessionID.zod,
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  export interface Interface {
    readonly get: (sessionID: SessionID) => Effect.Effect<Info>
    readonly list: () => Effect.Effect<Map<SessionID, Info>>
    readonly hasActiveProject: () => Effect.Effect<boolean>
    readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionStatus") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const projects = new Map<string, Map<SessionID, string>>()

      const state = yield* InstanceState.make(
        Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
      )

      const off = registerDisposer(async (directory) => {
        for (const [project, sessions] of projects) {
          for (const [sessionID, dir] of sessions) {
            if (dir === directory) sessions.delete(sessionID)
          }
          if (sessions.size === 0) projects.delete(project)
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
        const data = yield* InstanceState.get(state)
        return data.get(sessionID) ?? { type: "idle" as const }
      })

      const list = Effect.fn("SessionStatus.list")(function* () {
        return new Map(yield* InstanceState.get(state))
      })

      const hasActiveProject = Effect.fn("SessionStatus.hasActiveProject")(() =>
        Effect.sync(() => (projects.get(Instance.project.id)?.size ?? 0) > 0),
      )

      const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
        const data = yield* InstanceState.get(state)
        const project = Instance.project.id
        const sessions = projects.get(project) ?? new Map<SessionID, string>()
        if (status.type === "idle") sessions.delete(sessionID)
        if (status.type !== "idle") sessions.set(sessionID, Instance.directory)
        if (sessions.size > 0) projects.set(project, sessions)
        if (sessions.size === 0) projects.delete(project)
        yield* bus.publish(Event.Status, { sessionID, status })
        if (status.type === "idle") {
          yield* bus.publish(Event.Idle, { sessionID })
          data.delete(sessionID)
          return
        }
        data.set(sessionID, status)
      })

      return Service.of({ get, list, hasActiveProject, set })
    }),
  )

  const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(sessionID: SessionID) {
    return runPromise((svc) => svc.get(sessionID))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function hasActiveProject() {
    return runPromise((svc) => svc.hasActiveProject())
  }

  export async function set(sessionID: SessionID, status: Info) {
    return runPromise((svc) => svc.set(sessionID, status))
  }
}
