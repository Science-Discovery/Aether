import { EOL } from "os"
import { Skill } from "../../../skill"
import { categories } from "../../../skill/benchmark"
import { run } from "../../../skill/benchmark"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export const SkillCommand = cmd({
  command: "skill",
  describe: "list skills and run search benchmarks",
  builder: (yargs) =>
    yargs
      .command({
        command: "$0",
        describe: "list all available skills",
        async handler() {
          await bootstrap(process.cwd(), async () => {
            const skills = await Skill.all()
            process.stdout.write(JSON.stringify(skills, null, 2) + EOL)
          })
        },
      })
      .command({
        command: "benchmark",
        describe: "benchmark search models for skill discovery",
        builder: (yargs) =>
          yargs
            .option("model", {
              type: "array",
              string: true,
              describe: "specific provider/model ids to benchmark",
            })
            .option("runs", {
              type: "number",
              default: 2,
              describe: "number of repeated runs per query",
            })
            .option("mode", {
              type: "string",
              default: "both",
              choices: ["rerank", "live", "both"],
              describe: "benchmark fixed rerank fixtures, live search, or both",
            })
            .option("category", {
              type: "array",
              string: true,
              choices: categories,
              describe: "limit benchmark cases to selected categories",
            })
            .option("lang", {
              type: "string",
              default: "both",
              choices: ["zh", "en", "both"],
              describe: "limit benchmark cases by language",
            })
            .option("concurrency-model", {
              type: "number",
              describe: "parallel models to benchmark at once",
            })
            .option("concurrency-case", {
              type: "number",
              describe: "parallel rerank cases per model",
            })
            .option("concurrency-live", {
              type: "number",
              describe: "parallel live cases per model",
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "print raw benchmark data as JSON",
            }),
        async handler(args) {
          await bootstrap(process.cwd(), async () => {
            const out = await run({
              models: args.model?.map(String),
              runs: args.runs,
              mode: args.mode as "rerank" | "live" | "both",
              category: args.category?.map(String) as (typeof categories)[number][] | undefined,
              lang: args.lang as "zh" | "en" | "both",
              concurrency_model: args.concurrencyModel,
              concurrency_case: args.concurrencyCase,
              concurrency_live: args.concurrencyLive,
            })
            if (args.json) {
              process.stdout.write(JSON.stringify(out, null, 2) + EOL)
              return
            }
            process.stdout.write(out.markdown + EOL)
          })
        },
      })
      .demandCommand(0, 0),
  async handler() {},
})
