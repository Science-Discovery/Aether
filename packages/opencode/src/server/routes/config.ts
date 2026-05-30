import path from "path"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { Project } from "../../project/project"
import { EvolvedSkills } from "../../skill-evolution/evolved-skills"
import { Skill } from "../../skill"
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
      validator("json", z.object({ name: z.string(), enabled: z.boolean() })),
      async (c) => {
        const { name, enabled } = c.req.valid("json")
        await Config.toggleSkill(name, enabled)
        return c.json({ ok: true })
      },
    )
    .get(
      "/skills/evolution",
      describeRoute({
        summary: "List evolved skills",
        description:
          "List evolved skills from the project's .aether/skills/ and the global skill-evolution/<projectId>/skills/ directory.",
        operationId: "config.skills.listEvolution",
        responses: {
          200: {
            description: "List of evolved skills",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      name: z.string(),
                      description: z.string(),
                      content: z.string(),
                      category: z.string().optional(),
                      enabled: z.boolean().optional(),
                      evolution_enabled: z.boolean().optional(),
                      file: z.string(),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      validator("query", z.object({ directory: z.string().optional() })),
      async (c) => {
        const { directory } = c.req.valid("query")
        if (!directory) return c.json([])
        // Resolve the project id the same way Skill.available() does, so we read
        // the exact skill-evolution folder the write side created (method A).
        const { project } = await Project.fromDirectory(directory)
        const skills = await EvolvedSkills.list(directory, String(project.id))
        // Display state is computed purely from config (per-file disable lists),
        // never from SKILL.md frontmatter: a path in disabled_files renders as off.
        const cfg = await Config.get()
        const disabled = new Set((cfg.skills?.disabled_files ?? []).map((p) => path.resolve(p)))
        const evolutionDisabled = new Set((cfg.skills?.evolution_disabled_files ?? []).map((p) => path.resolve(p)))
        const withState = skills.map((s) => ({
          ...s,
          enabled: !disabled.has(path.resolve(s.file)),
          evolution_enabled: !evolutionDisabled.has(path.resolve(s.file)),
        }))
        return c.json(withState)
      },
    )
    .post(
      "/skills/evolution/toggle",
      describeRoute({
        summary: "Toggle evolved skill activation",
        description: "Enable or disable an evolved skill by its SKILL.md file path.",
        operationId: "config.skills.toggleEvolved",
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
        // enabled=true → skill should load → remove from disabled_files (on=false).
        await Skill.setSkillFileFlag(file, "disabled_files", !enabled)
        return c.json({ ok: true })
      },
    )
    .post(
      "/skills/evolution/toggle-evolution",
      describeRoute({
        summary: "Toggle skill self-evolution",
        description: "Allow or stop an evolved skill from self-evolving, by its SKILL.md file path.",
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
        // evolutionEnabled=true → may self-evolve → remove from evolution_disabled_files.
        await Skill.setSkillFileFlag(file, "evolution_disabled_files", !evolutionEnabled)
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
