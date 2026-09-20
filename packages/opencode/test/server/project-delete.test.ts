import { expect, test } from "bun:test"
import { Hono } from "hono"
import { Project } from "../../src/project/project"
import { ProjectRoutes } from "../../src/server/routes/project"
import { Log } from "../../src/util/log"
import { converse, tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const app = () => new Hono().route("/project", ProjectRoutes())

test("delete route treats missing, empty, and garbage bodies as non-cascade", async () => {
  await using tmp = await tmpdir({ git: true })
  const { project } = await Project.fromDirectory(tmp.path)
  await converse(tmp.path)

  // No body at all — legacy clients (and the exact "Malformed JSON in
  // request body" regression reported by the user).
  const noBody = await app().request(`/project/${project.id}`, { method: "DELETE" })
  expect(noBody.status).toBe(200)
  expect(await noBody.json()).toMatchObject({ status: "has_sessions", sessionCount: 1 })
  expect(Project.get(project.id)).toBeDefined()

  // JSON content-type with an empty body — what the app's client used to send.
  const emptyBody = await app().request(`/project/${project.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  })
  expect(emptyBody.status).toBe(200)
  expect(await emptyBody.json()).toMatchObject({ status: "has_sessions" })

  // Unparseable body must not 400 and must never cascade.
  const garbage = await app().request(`/project/${project.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "not json",
  })
  expect(garbage.status).toBe(200)
  expect((await garbage.json()).status).toBe("has_sessions")
  expect(Project.get(project.id)).toBeDefined()

  // A non-boolean cascade must be ignored, not coerced into deleting.
  const wrongType = await app().request(`/project/${project.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cascade: "yes" }),
  })
  expect(wrongType.status).toBe(200)
  expect((await wrongType.json()).status).toBe("has_sessions")
  expect(Project.get(project.id)).toBeDefined()
})

test("delete route cascades only on an explicit boolean cascade body", async () => {
  await using tmp = await tmpdir({ git: true })
  const { project } = await Project.fromDirectory(tmp.path)
  await converse(tmp.path)

  const response = await app().request(`/project/${project.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cascade: true }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: "ok" })
  expect(Project.get(project.id)).toBeUndefined()
})

test("sessions-preview route returns the sampled conversations", async () => {
  await using tmp = await tmpdir({ git: true })
  const { project } = await Project.fromDirectory(tmp.path)
  await converse(tmp.path)

  const response = await app().request(`/project/${project.id}/sessions-preview`)
  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data.sessions.length).toBe(1)
  expect(data.sessions[0].id.startsWith("ses_")).toBe(true)
})
