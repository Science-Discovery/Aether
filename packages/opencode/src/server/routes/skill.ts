import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Skill } from "../../skill"
import {
  Catalog,
  DescribeInput,
  DescribeResult,
  InstallJob,
  InstallInput,
  Installed,
  SearchInput,
  SearchOutput,
  UpdateInput,
} from "../../skill/catalog"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

export const SkillRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List skills",
        description: "Get a list of all available skills in the OpenCode system.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "List of skills",
            content: {
              "application/json": {
                schema: resolver(Skill.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Skill.all())
      },
    )
    .post(
      "/search",
      describeRoute({
        summary: "Search skills",
        description: "Search registry and external skill sources for the current project.",
        operationId: "skill.search",
        responses: {
          200: {
            description: "Search results",
            content: {
              "application/json": {
                schema: resolver(SearchOutput),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", SearchInput),
      async (c) => {
        return c.json(await Catalog.search(c.req.valid("json")))
      },
    )
    .get(
      "/installed",
      describeRoute({
        summary: "List installed skills",
        description: "Get installed managed skills visible to the current project.",
        operationId: "skill.installed",
        responses: {
          200: {
            description: "Installed skills",
            content: {
              "application/json": {
                schema: resolver(Installed.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Catalog.installed())
      },
    )
    .post(
      "/describe",
      describeRoute({
        summary: "Describe skill",
        description: "Generate a short Chinese summary for a search result card.",
        operationId: "skill.describe",
        responses: {
          200: {
            description: "Skill summary",
            content: {
              "application/json": {
                schema: resolver(DescribeResult),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", DescribeInput),
      async (c) => {
        return c.json(await Catalog.describe(c.req.valid("json")))
      },
    )
    .get(
      "/check",
      describeRoute({
        summary: "Check skill updates",
        description: "Get installed skills with update availability.",
        operationId: "skill.check",
        responses: {
          200: {
            description: "Installed skills with update status",
            content: {
              "application/json": {
                schema: resolver(Installed.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Catalog.check())
      },
    )
    .get(
      "/jobs",
      describeRoute({
        summary: "List skill install jobs",
        description: "Get current and recent background install jobs for the current project.",
        operationId: "skill.jobs",
        responses: {
          200: {
            description: "Install jobs",
            content: {
              "application/json": {
                schema: resolver(InstallJob.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Catalog.jobs())
      },
    )
    .post(
      "/install",
      describeRoute({
        summary: "Install skill",
        description: "Install a registry or external skill.",
        operationId: "skill.install",
        responses: {
          200: {
            description: "Install result",
            content: {
              "application/json": {
                schema: resolver(InstallJob),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", InstallInput),
      async (c) => {
        return c.json(await Catalog.install(c.req.valid("json")))
      },
    )
    .post(
      "/update",
      describeRoute({
        summary: "Update skills",
        description: "Update one or more installed managed skills.",
        operationId: "skill.update",
        responses: {
          200: {
            description: "Update result",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), updated: z.array(z.string()) })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", UpdateInput),
      async (c) => {
        return c.json(await Catalog.update(c.req.valid("json")))
      },
    ),
)
