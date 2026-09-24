import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { InstanceBootstrap, refreshProject } from "../../project/bootstrap"
import { Filesystem } from "../../util/filesystem"
import z from "zod"
import { ProjectID } from "../../project/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/recent",
      describeRoute({
        summary: "List recent projects and directories",
        description: "Returns the recent project feed used by the web app and WeChat bridge.",
        operationId: "project.recent",
        responses: {
          200: {
            description: "Recent project feed",
            content: {
              "application/json": {
                schema: resolver(Project.RecentInfo.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Project.recentList())
      },
    )
    .get(
      "/directories",
      describeRoute({
        summary: "List all known directories",
        description: "Returns all project worktrees plus unique session directories.",
        operationId: "project.directories",
        responses: {
          200: {
            description: "List of directory paths",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string())),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Project.directories())
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .post(
      "/open",
      describeRoute({
        summary: "Open a project directory",
        description:
          "Validate, register and boot a project directory. This is the explicit entry point for opening projects: arbitrary request-supplied directories never boot instances on their own.",
        operationId: "project.open",
        responses: {
          200: {
            description: "Project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ directory: z.string() })),
      async (c) => {
        const dir = Filesystem.resolve(c.req.valid("json").directory)
        if (!(await Filesystem.isDir(dir))) return c.json({ error: "Directory not found" }, 400)
        const project = await Instance.provide({
          directory: dir,
          init: InstanceBootstrap,
          fn: () => Instance.project,
        })
        return c.json(project)
      },
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        const prev = Instance.project
        const next = await Project.initGit({
          directory: dir,
          project: prev,
        })
        if (next.vcs !== prev.vcs) {
          await refreshProject(next)
          await Project.emitUpdated(next)
        }
        return c.json(next)
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UpdateInput.omit({ projectID: true })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const body = c.req.valid("json")
        const project = await Project.update({ ...body, projectID })
        return c.json(project)
      },
    )
    .delete(
      "/:projectID",
      describeRoute({
        summary: "Delete project",
        description:
          "Remove a project and its database. Fails with the blocking sessions if the project has any — pass cascade to delete them together with the project.",
        operationId: "project.delete",
        responses: {
          200: {
            description: "Deletion result",
            content: {
              "application/json": {
                schema: resolver(Project.RemoveResult),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        // Legacy clients delete with no body at all — treat missing or
        // unparseable JSON as non-cascade instead of rejecting.
        const body = z
          .object({ cascade: z.boolean().optional() })
          .catch({})
          .parse(await c.req.json().catch(() => undefined))
        const result = Project.remove(projectID, body)
        return c.json(result)
      },
    )
    .get(
      "/:projectID/sessions-preview",
      describeRoute({
        summary: "Preview project sessions",
        description:
          "List the sessions a project removal would delete, read directly from the project database. Sessions here may not be visible in the UI when the workspace directory no longer exists.",
        operationId: "project.sessionsPreview",
        responses: {
          200: {
            description: "Session preview",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    sessions: z.array(
                      z.object({
                        id: z.string(),
                        title: z.string().nullable(),
                        time_created: z.number(),
                        time_archived: z.number().nullable(),
                      }),
                    ),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        return c.json({ sessions: Project.sessions(projectID) })
      },
    )
    .get(
      "/:projectID/session-count",
      describeRoute({
        summary: "Get session count for project",
        description: "Return the number of sessions in a project database.",
        operationId: "project.sessionCount",
        responses: {
          200: {
            description: "Session count",
            content: {
              "application/json": {
                schema: resolver(z.object({ count: z.number() })),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const count = Project.sessionCount(projectID)
        return c.json({ count })
      },
    ),
)
