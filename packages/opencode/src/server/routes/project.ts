import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import z from "zod"
import { ProjectID } from "../../project/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { InstanceBootstrap } from "../../project/bootstrap"

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
        if (next.id === prev.id && next.vcs === prev.vcs && next.worktree === prev.worktree) return c.json(next)
        await Instance.reload({
          directory: dir,
          worktree: dir,
          project: next,
          init: InstanceBootstrap,
        })
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
        description: "Remove a project and its database. Fails if the project has sessions — delete those first.",
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
        const result = Project.remove(projectID)
        return c.json(result)
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
