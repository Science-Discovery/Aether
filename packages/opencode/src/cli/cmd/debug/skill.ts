import { EOL } from "os"
import { Skill } from "../../../skill"
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
              default: "rerank",
              choices: ["rerank", "live", "both"],
              describe: "benchmark fixed rerank fixtures, live search, or both",
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
