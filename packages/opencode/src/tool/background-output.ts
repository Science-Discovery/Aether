import { Tool } from "./tool"
import z from "zod"
import { BackgroundTask } from "../session/background"

interface BackgroundOutputMetadata {
  taskID: string
  status: string
  executionTime: number
}

export const BackgroundOutputTool = Tool.define("background_output", {
  description:
    "Retrieve results from a background subagent task. Use this when a background task has completed and you need its output. The result includes status (completed/error/partial/timeout), text output, and error details if applicable.",
  parameters: z.object({
    task_id: z.string().describe("The background task ID returned by the task tool when mode=background"),
  }),
  async execute(params, ctx) {
    const result = await BackgroundTask.output(params.task_id)

    const output = [
      `Background task result (task_id: ${result.taskID})`,
      `Status: ${result.status}`,
      `Execution time: ${result.executionTime}ms`,
      `Steps completed: ${result.stepsCompleted}`,
      "",
      ...(result.error
        ? [
            "Error:",
            `  Type: ${result.error.type}`,
            `  Message: ${result.error.message}`,
            `  Retryable: ${result.error.retryable}`,
            ...(result.error.statusCode ? [`  Status code: ${result.error.statusCode}`] : []),
            "",
          ]
        : []),
      ...(result.text ? ["<task_result>", result.text, "</task_result>"] : ["No text output available."]),
    ].join("\n")

    return {
      title: `Background task: ${result.status}`,
      metadata: {
        taskID: result.taskID,
        status: result.status,
        executionTime: result.executionTime,
      } as BackgroundOutputMetadata,
      output,
    }
  },
})
