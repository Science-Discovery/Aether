import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cron } from "../../src/cron"
import { CronJobStateTable, CronRunTable } from "../../src/cron/cron.sql"
import {
  CronCreateTool,
  CronListTool,
  CronRunNowTool,
  CronSetGlobalEnabledTool,
} from "../../src/tool/cron"
import { ToolRegistry } from "../../src/tool/registry"
import { Database, eq } from "../../src/storage/db"
import { Global } from "../../src/global"
import { Config } from "../../src/config/config"
import { tmpdir } from "../fixture/fixture"
import { Project } from "../../src/project/project"
import { ProjectID } from "../../src/project/schema"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"

const actionName = (name: string) => `cron_test_${name}_${Date.now()}_${Math.random().toString(36).slice(2)}`

async function resetCron() {
  await Cron.stop()
  Cron.resetAgentDispatcher()
  await Config.updateGlobal({ cron: { enabled: true } } as any)
  Database.use((db) => {
    db.delete(CronRunTable).run()
    db.delete(CronJobStateTable).run()
  })
  await fs.rm(path.join(Global.Path.data, "cron"), { recursive: true, force: true })
}

function state(jobID: string) {
  return Database.use((db) => db.select().from(CronJobStateTable).where(eq(CronJobStateTable.job_id, jobID)).get())
}

function setState(jobID: string, patch: Partial<typeof CronJobStateTable.$inferInsert>) {
  Database.use((db) =>
    db
      .update(CronJobStateTable)
      .set({ ...patch, updated_at: Date.now() })
      .where(eq(CronJobStateTable.job_id, jobID))
      .run(),
  )
}

function toolContext(sessionID = "ses_test") {
  const asks: Array<{ permission: string; patterns: string[]; metadata: Record<string, unknown> }> = []
  return {
    asks,
    ctx: {
      sessionID,
      messageID: "msg_test",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => undefined,
      ask: async (input: { permission: string; patterns: string[]; metadata: Record<string, unknown> }) => {
        asks.push(input)
      },
    } as any,
  }
}

async function appendUserMessage(sessionID: SessionID, text: string) {
  const message = await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.4" },
    tools: {},
    mode: "build",
  } as any)
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
  return message
}

async function captureEventDirectories(run: () => Promise<void>) {
  const directories: string[] = []
  const listener = (event: { directory?: string }) => {
    if (event.directory) directories.push(event.directory)
  }
  const { GlobalBus } = await import("../../src/bus/global")
  GlobalBus.on("event", listener)
  try {
    await run()
  } finally {
    GlobalBus.off("event", listener)
  }
  return directories
}

beforeEach(async () => {
  await resetCron()
})

afterEach(async () => {
  await resetCron()
})

describe("Cron core", () => {
  test("createJob generates an id and initializes state", async () => {
    const created = await Cron.createJob({
      name: "nightly direct",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: {
        action: "debug_noop",
      },
    })

    expect(created.definition.id).toBeTruthy()
    expect(created.definition.enabled).toBe(true)
    expect(created.state.enabled).toBe(true)
    expect(typeof created.state.next_run_at).toBe("number")
  })

  test("createJob rejects caller-supplied id", async () => {
    const error = await Cron.createJob({
      id: "job_manual",
      name: "bad",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action: "debug_noop" },
    }).catch((error) => error)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("id is generated automatically")
  })

  test("runJobNow executes a registered direct action and records success", async () => {
    const action = actionName("success")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "handled direct action",
    }))

    const created = await Cron.createJob({
      name: "manual direct",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    const run = await Cron.runJobNow({ id: created.definition.id })
    const next = state(created.definition.id)

    expect(run.status).toBe("success")
    expect(run.output_summary).toBe("handled direct action")
    expect(next?.last_status).toBe("success")
    expect(typeof next?.last_run_at).toBe("number")

    Cron.unregisterDirectAction(action)
  })

  test("runJobNow skips when the same job is already marked running", async () => {
    const action = actionName("already-running")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "should not run while already running",
    }))

    const created = await Cron.createJob({
      name: "manual while running",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    setState(created.definition.id, {
      running: true,
      enabled: true,
    })

    const run = await Cron.runJobNow({ id: created.definition.id })
    const next = state(created.definition.id)

    expect(run.status).toBe("skipped")
    expect(run.output_summary).toContain("already in progress")
    expect(next?.last_status).toBe("skipped")
    expect(next?.last_run_at).toBeNull()

    Cron.unregisterDirectAction(action)
  })

  test("manual run logs skipped when cron is globally disabled", async () => {
    const action = actionName("disabled")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "should not run",
    }))

    const created = await Cron.createJob({
      name: "manual disabled",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    await Config.updateGlobal({ cron: { enabled: false } } as any)
    const run = await Cron.runJobNow({ id: created.definition.id })
    const next = state(created.definition.id)

    expect(run.status).toBe("skipped")
    expect(run.output_summary).toContain("cron is disabled")
    expect(next?.last_status).toBe("skipped")
    expect(next?.last_run_at).toBeNull()

    Cron.unregisterDirectAction(action)
  })

  test("scheduled tick silently advances cron jobs while cron is disabled", async () => {
    const action = actionName("scheduled-disabled")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "should not run",
    }))

    const created = await Cron.createJob({
      name: "scheduled disabled",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    const before = Date.now() - 5_000
    setState(created.definition.id, {
      next_run_at: before,
      last_status: null,
      enabled: true,
      running: false,
    })

    await Config.updateGlobal({ cron: { enabled: false } } as any)
    await Cron.tick()

    const next = state(created.definition.id)
    const runs = await Cron.listRuns({ id: created.definition.id, count: 100 })

    expect(typeof next?.next_run_at).toBe("number")
    expect((next?.next_run_at ?? 0) > before).toBe(true)
    expect(next?.last_status).toBeNull()
    expect(runs).toHaveLength(0)

    Cron.unregisterDirectAction(action)
  })

  test("scheduled tick silently expires due once jobs while cron is disabled", async () => {
    const action = actionName("once-expired")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "should not run",
    }))

    const created = await Cron.createJob({
      name: "once disabled",
      mode: "direct",
      schedule_type: "once",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    setState(created.definition.id, {
      next_run_at: Date.now() - 5_000,
      last_status: null,
      enabled: true,
      running: false,
    })

    await Config.updateGlobal({ cron: { enabled: false } } as any)
    await Cron.tick()

    const next = state(created.definition.id)
    const runs = await Cron.listRuns({ id: created.definition.id, count: 100 })

    expect(next?.enabled).toBe(false)
    expect(next?.last_status).toBe("expired")
    expect(next?.next_run_at).toBeNull()
    expect(runs).toHaveLength(0)

    Cron.unregisterDirectAction(action)
  })

  test("scheduled tick advances overdue interval jobs to a future time while cron is disabled", async () => {
    const action = actionName("interval-disabled")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "should not run",
    }))

    const created = await Cron.createJob({
      name: "interval disabled",
      mode: "direct",
      schedule_type: "interval",
      schedule_value: 10,
      payload: { action },
    })

    const now = Date.now()
    setState(created.definition.id, {
      start_at: now - 60_000,
      next_run_at: now - 10_000,
      last_status: null,
      enabled: true,
      running: false,
    })

    await Config.updateGlobal({ cron: { enabled: false } } as any)
    await Cron.tick()

    const next = state(created.definition.id)
    const runs = await Cron.listRuns({ id: created.definition.id, count: 100 })

    expect(typeof next?.next_run_at).toBe("number")
    expect((next?.next_run_at ?? 0) > now).toBe(true)
    expect(next?.last_status).toBeNull()
    expect(runs).toHaveLength(0)

    Cron.unregisterDirectAction(action)
  })

  test("agent modes use dispatcher results and record created session ids", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    Cron.setAgentDispatcher({
      async isolated({ definition }) {
        return {
          output_summary: `isolated ${definition.name}`,
          project_id: definition.project_id,
          session_id: "ses_new_isolated",
          created_session_id: "ses_new_isolated",
        }
      },
      async session({ definition }) {
        return {
          output_summary: `session ${definition.name}`,
          project_id: definition.project_id,
          session_id: "ses_replacement",
          created_session_id: "ses_replacement",
        }
      },
      async message({ definition }) {
        return {
          output_summary: `message ${definition.name}`,
          project_id: definition.project_id,
          session_id: definition.session_id,
          created_session_id: null,
        }
      },
    })

    const isolated = await Cron.createJob({
      name: "isolated",
      mode: "isolated_agent",
      project_id: project.id,
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { message: "hello isolated" },
    })

    const session = await Cron.createJob({
      name: "session",
      mode: "session_agent",
      project_id: project.id,
      session_id: "ses_missing",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { message: "hello session" },
    })

    const isolatedRun = await Cron.runJobNow({ id: isolated.definition.id })
    const sessionRun = await Cron.runJobNow({ id: session.definition.id })

    expect(isolatedRun.status).toBe("success")
    expect(isolatedRun.session_id).toBe("ses_new_isolated")
    expect(isolatedRun.created_session_id).toBe("ses_new_isolated")

    expect(sessionRun.status).toBe("success")
    expect(sessionRun.session_id).toBe("ses_replacement")
    expect(sessionRun.created_session_id).toBe("ses_replacement")
  })

  test("agent_message mode appends an assistant message without running the LLM loop", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "cron notify" })
        const created = await Cron.createJob({
          name: "assistant notification",
          mode: "agent_message",
          project_id: project.id,
          session_id: session.id,
          schedule_type: "cron",
          schedule_value: "0 3 * * *",
          payload: {
            message: "time to stretch",
            agent: "build",
          },
        })

        const run = await Cron.runJobNow({ id: created.definition.id })
        const messages = await Session.messages({ sessionID: session.id })
        const assistant = messages.find((message) => message.info.role === "assistant")
        const text = assistant?.parts.find((part) => part.type === "text")

        expect(run.status).toBe("success")
        expect(run.output_summary).toContain("Created cron agent message")
        expect(assistant?.info.role).toBe("assistant")
        expect(text?.type).toBe("text")
        expect(text?.text).toBe("time to stretch")
        expect(text?.metadata?.source).toBe("cron")
      },
    })
  })

  test("agent_message mode attaches the assistant message to the latest user turn", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "cron notify latest" })
        const first = await appendUserMessage(session.id, "first")
        const latest = await appendUserMessage(session.id, "latest")
        const created = await Cron.createJob({
          name: "assistant notification latest",
          mode: "agent_message",
          project_id: project.id,
          session_id: session.id,
          schedule_type: "cron",
          schedule_value: "0 3 * * *",
          payload: {
            message: "latest turn reminder",
            agent: "build",
          },
        })

        await Cron.runJobNow({ id: created.definition.id })
        const messages = await Session.messages({ sessionID: session.id })
        const assistant = messages.findLast((message) => message.info.role === "assistant" && message.info.parentID)

        expect(first.id).not.toBe(latest.id)
        expect(assistant?.info.role).toBe("assistant")
        if (assistant?.info.role !== "assistant") throw new Error("Expected an assistant cron message")
        expect(assistant.info.parentID).toBe(latest.id)
      },
    })
  })

  test("agent_message mode emits session events on the existing session directory for global projects", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "cron global notify" })
        expect(session.projectID).toBe(ProjectID.global)
        expect(session.directory).toBe(tmp.path)

        const created = await Cron.createJob({
          name: "assistant notification global",
          mode: "agent_message",
          project_id: "global",
          session_id: session.id,
          schedule_type: "cron",
          schedule_value: "0 3 * * *",
          payload: {
            message: "global reminder",
            agent: "build",
          },
        })

        const directories = await captureEventDirectories(async () => {
          await Cron.runJobNow({ id: created.definition.id })
        })

        expect(directories).toContain(tmp.path)
        expect(directories).not.toContain("/")
      },
    })
  })

  test("recover clears stale running state without executing due jobs until a later tick", async () => {
    const action = actionName("recover")
    let executions = 0
    Cron.registerDirectAction(action, async () => {
      executions += 1
      return {
        output_summary: "recover action ran",
      }
    })

    const created = await Cron.createJob({
      name: "recover direct",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    setState(created.definition.id, {
      running: true,
      enabled: true,
      next_run_at: Date.now() - 5_000,
    })

    await Cron.recover()

    const recovered = state(created.definition.id)
    const runsAfterRecover = await Cron.listRuns({ id: created.definition.id, count: 100 })

    expect(recovered?.running).toBe(false)
    expect(runsAfterRecover).toHaveLength(0)
    expect(executions).toBe(0)

    await Cron.tick()

    const runsAfterTick = await Cron.listRuns({ id: created.definition.id, count: 100 })
    expect(runsAfterTick).toHaveLength(1)
    expect(runsAfterTick[0]?.status).toBe("success")
    expect(executions).toBe(1)

    Cron.unregisterDirectAction(action)
  })

  test("updating an expired once job schedule revives it", async () => {
    const action = actionName("revive-once")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "revived once",
    }))

    const created = await Cron.createJob({
      name: "revive once",
      mode: "direct",
      schedule_type: "once",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    setState(created.definition.id, {
      enabled: false,
      next_run_at: null,
      last_status: "expired",
      running: false,
    })

    const updated = await Cron.updateJob({
      id: created.definition.id,
      patch: {
        schedule_value: "5 3 * * *",
      },
    })

    expect(updated.state.enabled).toBe(true)
    expect(updated.state.last_status).toBeNull()
    expect(typeof updated.state.next_run_at).toBe("number")

    Cron.unregisterDirectAction(action)
  })

  test("changing schedule_type to and from interval manages start_at correctly", async () => {
    const action = actionName("interval-transition")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "interval transition",
    }))

    const created = await Cron.createJob({
      name: "schedule transition",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    const interval = await Cron.updateJob({
      id: created.definition.id,
      patch: {
        schedule_type: "interval",
        schedule_value: 30,
        timezone: null,
      },
    })

    expect(typeof interval.state.start_at).toBe("number")
    expect(typeof interval.state.next_run_at).toBe("number")

    const backToCron = await Cron.updateJob({
      id: created.definition.id,
      patch: {
        schedule_type: "cron",
        schedule_value: "10 3 * * *",
      },
    })

    expect(backToCron.state.start_at).toBeNull()
    expect(typeof backToCron.state.next_run_at).toBe("number")

    Cron.unregisterDirectAction(action)
  })

  test("invalid job files are skipped during scans without deleting prior state", async () => {
    const action = actionName("invalid-file")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "invalid file preservation",
    }))

    const created = await Cron.createJob({
      name: "invalid file preserve state",
      mode: "direct",
      schedule_type: "cron",
      schedule_value: "0 3 * * *",
      payload: { action },
    })

    const jobFile = path.join(Global.Path.data, "cron", "jobs", `${created.definition.id}.json`)
    await fs.writeFile(
      jobFile,
      JSON.stringify({
        ...created.definition,
        mode: "not-a-real-mode",
      }),
    )

    const jobs = await Cron.listJobs()
    const next = state(created.definition.id)

    expect(jobs.some((job) => job.definition.id === created.definition.id)).toBe(false)
    expect(next?.job_id).toBe(created.definition.id)
    expect(next?.enabled).toBe(created.state.enabled)

    Cron.unregisterDirectAction(action)
  })
})

describe("Cron routes", () => {
  test("server cron routes create, list, run, fetch runs, and delete jobs", async () => {
    const action = actionName("route")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "route action done",
    }))

    const app = Server.createApp({})

    const create = await app.request("/cron/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "route job",
        mode: "direct",
        schedule_type: "cron",
        schedule_value: "0 3 * * *",
        payload: { action },
      }),
    })
    expect(create.status).toBe(200)
    const created = (await create.json()) as {
      definition: { id: string; name: string }
      state: { enabled: boolean }
    }
    expect(created.definition.name).toBe("route job")
    expect(created.state.enabled).toBe(true)

    const list = await app.request("/cron/jobs")
    expect(list.status).toBe(200)
    const listed = (await list.json()) as Array<{ definition: { id: string } }>
    expect(listed.some((item) => item.definition.id === created.definition.id)).toBe(true)

    const run = await app.request(`/cron/jobs/${created.definition.id}/run`, {
      method: "POST",
    })
    expect(run.status).toBe(200)
    const runBody = (await run.json()) as { run_id: string; status: string }
    expect(runBody.status).toBe("success")

    const runs = await app.request(`/cron/jobs/${created.definition.id}/runs?count=0`)
    expect(runs.status).toBe(200)
    expect(await runs.json()).toEqual([])

    const latestRuns = await app.request(`/cron/jobs/${created.definition.id}/runs?count=5`)
    expect(latestRuns.status).toBe(200)
    const latestBody = (await latestRuns.json()) as Array<{ run_id: string }>
    expect(latestBody).toHaveLength(1)
    expect(latestBody[0]?.run_id).toBe(runBody.run_id)

    const singleRun = await app.request(`/cron/runs/${runBody.run_id}`)
    expect(singleRun.status).toBe(200)
    const singleBody = (await singleRun.json()) as { run_id: string }
    expect(singleBody.run_id).toBe(runBody.run_id)

    const deleted = await app.request(`/cron/jobs/${created.definition.id}`, {
      method: "DELETE",
    })
    expect(deleted.status).toBe(200)
    const deletedBody = (await deleted.json()) as { ok: boolean; definition: { id: string } }
    expect(deletedBody.ok).toBe(true)
    expect(deletedBody.definition.id).toBe(created.definition.id)

    Cron.unregisterDirectAction(action)
  })
})

describe("Cron agent tools", () => {
  test("tool registry exposes cron tools", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()

        expect(ids).toContain("cron_list")
        expect(ids).toContain("cron_get")
        expect(ids).toContain("cron_create")
        expect(ids).toContain("cron_update")
        expect(ids).toContain("cron_delete")
        expect(ids).toContain("cron_run_now")
        expect(ids).toContain("cron_runs")
        expect(ids).toContain("cron_set_global_enabled")
      },
    })
  })

  test("cron tools create, list, run, and update global enabled state", async () => {
    const action = actionName("tool")
    Cron.registerDirectAction(action, async () => ({
      output_summary: "tool direct action",
    }))

    const { asks, ctx } = toolContext()
    const create = await CronCreateTool.init()
    const list = await CronListTool.init()
    const runNow = await CronRunNowTool.init()
    const setGlobal = await CronSetGlobalEnabledTool.init()

    const created = await create.execute(
      {
        name: "tool-created cron",
        mode: "direct",
        schedule_type: "cron",
        schedule_value: "0 3 * * *",
        payload: { action },
      },
      ctx,
    )

    const id = String(created.metadata.id)
    expect(id).toBeTruthy()
    expect(created.output).toContain("tool-created cron")
    expect(asks.at(-1)?.permission).toBe("cron")
    expect(asks.at(-1)?.metadata.action).toBe("create")

    const listed = await list.execute({}, ctx)
    expect(listed.output).toContain(id)
    expect(listed.output).toContain("tool-created cron")

    const run = await runNow.execute({ id }, ctx)
    expect(run.output).toContain("tool direct action")
    expect(run.metadata.status).toBe("success")

    const disabled = await setGlobal.execute({ enabled: false }, ctx)
    expect(disabled.output).toContain("disabled")

    const skipped = await runNow.execute({ id }, ctx)
    expect(skipped.metadata.status).toBe("skipped")
    expect(skipped.output).toContain("cron is disabled")

    Cron.unregisterDirectAction(action)
  })

  test("cron_create resolves current project and session for session_agent jobs", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await Session.create({ title: "source session" })
        const { ctx } = toolContext(source.id)
        const create = await CronCreateTool.init()

        const created = await create.execute(
          {
            name: "current session cron",
            mode: "session_agent",
            schedule_type: "cron",
            schedule_value: "0 3 * * *",
            payload: { message: "hello current" },
          },
          ctx,
        )

        const job = created.metadata.job as Awaited<ReturnType<typeof Cron.createJob>>
        expect(job.definition.project_id).toBe(source.projectID)
        expect(job.definition.session_id).toBe(source.id)
      },
    })
  })
})
