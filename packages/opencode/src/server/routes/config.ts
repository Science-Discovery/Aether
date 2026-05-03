import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

const log = Log.create({ service: "server" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.get())
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/skills",
      describeRoute({
        summary: "List default skills",
        description: "List all default skills from the .aether/skills/ directory.",
        operationId: "config.skills.list",
        responses: {
          200: {
            description: "List of default skills",
            content: {
              "application/json": {
                schema: resolver(z.array(Config.DefaultSkill)),
              },
            },
          },
        },
      }),
      async (c) => {
        const skills = await Config.listDefaultSkills()
        return c.json(skills)
      },
    )
    .get(
      "/skills/evolution",
      describeRoute({
        summary: "List evolution skills",
        description: "List skills from the current project's .aether/skills/ and all global .aether/skills/ directories.",
        operationId: "config.skills.listEvolution",
        responses: {
          200: {
            description: "List of evolution skills",
            content: {
              "application/json": {
                schema: resolver(z.array(Config.DefaultSkill)),
              },
            },
          },
        },
      }),
      async (c) => {
        const skills = await Config.listEvolutionSkills()
        return c.json(skills)
      },
    )
    .get(
      "/skills/managed",
      describeRoute({
        summary: "List managed skills",
        description: "List all skills from the managed skills directory (~/.local/share/aether/skills/).",
        operationId: "config.skills.listManaged",
        responses: {
          200: {
            description: "List of managed skills",
            content: {
              "application/json": {
                schema: resolver(z.array(Config.DefaultSkill)),
              },
            },
          },
        },
      }),
      async (c) => {
        const skills = await Config.listManagedSkills()
        return c.json(skills)
      },
    )
    .get(
      "/skills/managed/dir",
      describeRoute({
        summary: "Get managed skills directory",
        description: "Get the absolute path of the managed skills directory.",
        operationId: "config.skills.getManagedDir",
        responses: {
          200: {
            description: "Managed skills directory path",
            content: {
              "application/json": {
                schema: resolver(z.object({ path: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ path: Config.getManagedSkillsDir() })
      },
    )
    .post(
      "/skills",
      describeRoute({
        summary: "Create or update a default skill",
        description: "Create or update a skill in .aether/skills/.",
        operationId: "config.skills.save",
        responses: {
          200: {
            description: "Skill saved",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
        },
      }),
      validator("json", Config.DefaultSkill),
      async (c) => {
        const { name, description, content } = c.req.valid("json")
        await Config.saveDefaultSkill(name, description, content)
        return c.json({ ok: true })
      },
    )
    .delete(
      "/skills/:name",
      describeRoute({
        summary: "Delete a default skill",
        description: "Delete a skill from .aether/skills/.",
        operationId: "config.skills.delete",
        responses: {
          200: {
            description: "Skill deleted",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        await Config.deleteDefaultSkill(name)
        return c.json({ ok: true })
      },
    )
    .post(
      "/skills/defaults",
      describeRoute({
        summary: "Add default skills to project config",
        description: "Add the default skills from .aether/skills/ to the project's aether.jsonc skills.paths.",
        operationId: "config.skills.addDefaults",
        responses: {
          200: {
            description: "Successfully added default skills",
            content: {
              "application/json": {
                schema: resolver(z.object({ added: z.array(z.string()) })),
              },
            },
          },
        },
      }),
      async (c) => {
        const added = await Config.addDefaultSkills()
        return c.json({ added })
      },
    )
    .post(
      "/skills/toggle",
      describeRoute({
        summary: "Toggle skill activation",
        description: "Enable or disable a default skill by name.",
        operationId: "config.skills.toggle",
        responses: {
          200: {
            description: "Skill toggled",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
        },
      }),
      validator("json", z.object({ file: z.string(), enabled: z.boolean() })),
      async (c) => {
        const { file, enabled } = c.req.valid("json")
        await Config.toggleSkill(file, enabled)
        return c.json({ ok: true })
      },
    )
    .post(
      "/skills/toggle-evolution",
      describeRoute({
        summary: "Toggle skill evolution",
        description: "Enable or disable background auto-evolution for a skill by file path.",
        operationId: "config.skills.toggleEvolution",
        responses: {
          200: {
            description: "Skill evolution toggled",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
        },
      }),
      validator("json", z.object({ file: z.string(), evolutionEnabled: z.boolean() })),
      async (c) => {
        const { file, evolutionEnabled } = c.req.valid("json")
        await Config.toggleSkillEvolution(file, evolutionEnabled)
        return c.json({ ok: true })
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    ),
)
