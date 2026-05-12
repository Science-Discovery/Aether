import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Cron } from "@/cron"

const JobView = z.object({
  definition: Cron.Definition,
  state: Cron.State.nullable(),
})

const DeleteResult = z.object({
  ok: z.literal(true),
  job_id: z.string(),
  definition: Cron.Definition,
})

const CreateBody = z.record(z.string(), z.unknown())
const UpdateBody = z.record(z.string(), z.unknown())
const AssistantBody = z.object({
  instruction: z.string().min(1),
  selected_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
})

export const CronRoutes = lazy(() =>
  new Hono()
    .post(
      "/assistant",
      describeRoute({
        summary: "Create or update a cron job from a short natural language instruction",
        operationId: "cron.assistant",
        responses: {
          200: {
            description: "Cron assistant result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    action: z.enum(["create", "update", "reject"]),
                    summary: z.string(),
                    job: JobView.nullable(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator("json", AssistantBody),
      async (c) => c.json(await Cron.assist(c.req.valid("json"))),
    )
    .get(
      "/jobs",
      describeRoute({
        summary: "List cron jobs",
        operationId: "cron.jobs.list",
        responses: {
          200: {
            description: "Cron jobs with current state",
            content: {
              "application/json": {
                schema: resolver(JobView.array()),
              },
            },
          },
        },
      }),
      async (c) => c.json(await Cron.listJobs()),
    )
    .post(
      "/jobs",
      describeRoute({
        summary: "Create cron job",
        operationId: "cron.jobs.create",
        responses: {
          200: {
            description: "Created cron job",
            content: {
              "application/json": {
                schema: resolver(JobView),
              },
            },
          },
        },
      }),
      validator("json", CreateBody),
      async (c) => c.json(await Cron.createJob(c.req.valid("json"))),
    )
    .get(
      "/jobs/:id",
      describeRoute({
        summary: "Get cron job",
        operationId: "cron.jobs.get",
        responses: {
          200: {
            description: "Cron job with current state",
            content: {
              "application/json": {
                schema: resolver(JobView),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await Cron.getJob(c.req.valid("param").id)),
    )
    .patch(
      "/jobs/:id",
      describeRoute({
        summary: "Update cron job",
        operationId: "cron.jobs.update",
        responses: {
          200: {
            description: "Updated cron job",
            content: {
              "application/json": {
                schema: resolver(JobView),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", UpdateBody),
      async (c) =>
        c.json(
          await Cron.updateJob({
            id: c.req.valid("param").id,
            patch: c.req.valid("json"),
          }),
        ),
    )
    .delete(
      "/jobs/:id",
      describeRoute({
        summary: "Delete cron job",
        operationId: "cron.jobs.delete",
        responses: {
          200: {
            description: "Deleted cron job definition",
            content: {
              "application/json": {
                schema: resolver(DeleteResult),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await Cron.deleteJob(c.req.valid("param"))),
    )
    .post(
      "/jobs/:id/run",
      describeRoute({
        summary: "Run cron job now",
        operationId: "cron.jobs.run",
        responses: {
          200: {
            description: "Cron run result",
            content: {
              "application/json": {
                schema: resolver(Cron.Run),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await Cron.runJobNow(c.req.valid("param"))),
    )
    .get(
      "/jobs/:id/runs",
      describeRoute({
        summary: "List recent cron runs for a job",
        operationId: "cron.jobs.runs",
        responses: {
          200: {
            description: "Recent cron runs",
            content: {
              "application/json": {
                schema: resolver(Cron.Run.array()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "query",
        z.object({
          count: z.coerce.number().int().optional(),
        }),
      ),
      async (c) =>
        c.json(
          await Cron.listRuns({
            id: c.req.valid("param").id,
            count: c.req.valid("query").count,
          }),
        ),
    )
    .get(
      "/runs/:run_id",
      describeRoute({
        summary: "Get cron run",
        operationId: "cron.runs.get",
        responses: {
          200: {
            description: "Single cron run",
            content: {
              "application/json": {
                schema: resolver(Cron.Run.nullable()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ run_id: z.string() })),
      async (c) => c.json(await Cron.getRun(c.req.valid("param"))),
    ),
)
