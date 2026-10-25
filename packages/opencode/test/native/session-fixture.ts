import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"
import path from "node:path"

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 1.0.0\n")
  process.exit(0)
}

const root = process.cwd()
const cfg = (await Bun.file(path.join(root, "scenario.json")).json()) as { mode?: string }
const pending = new Map<string, { threadId: string; turnId: string; itemId: string }>()
const threads = new Map<
  string,
  {
    id: string
    parentThreadId: string | null
    sessionId: string
    agentNickname: string | null
    status: { type: string }
    turns: Record<string, unknown>[]
  }
>()
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const notify = (method: string, params: unknown) => write({ method, params })
const changes = [
  { path: "paper.tex", kind: { type: "update", move_path: null }, diff: "-Old result\n+Verified result" },
]

function complete(threadId: string, turnId: string) {
  const text = threads.get(threadId)?.parentThreadId ? "Child evidence" : "Native response"
  const item = { id: "answer", type: "agentMessage", text, phase: "final_answer" }
  notify("item/started", { threadId, turnId, item: { ...item, text: "" } })
  notify("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: text.slice(0, 7) })
  notify("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: text.slice(7) })
  notify("item/completed", { threadId, turnId, item })
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      last: { totalTokens: 12, inputTokens: 7, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 },
      total:
        cfg.mode === "usage"
          ? { totalTokens: 162, inputTokens: 107, cachedInputTokens: 22, outputTokens: 55, reasoningOutputTokens: 11 }
          : { totalTokens: 12, inputTokens: 7, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 },
    },
  })
  if (cfg.mode === "usage") {
    const tokenUsage = {
      last: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0 },
      total: { totalTokens: 167, inputTokens: 110, cachedInputTokens: 23, outputTokens: 57, reasoningOutputTokens: 11 },
    }
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage })
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage })
  }
  const turn = { id: turnId, status: "completed", items: [item], error: null }
  const thread = threads.get(threadId)
  if (thread) {
    thread.status.type = "idle"
    thread.turns = [turn]
  }
  notify("turn/completed", { threadId, turn })
}

for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line) as {
    id?: string | number
    method?: string
    params?: Record<string, unknown>
    result?: unknown
  }
  await appendFile(path.join(root, "calls.jsonl"), JSON.stringify(value) + "\n")
  if (!value.method) {
    const turn = pending.get(String(value.id))
    if (turn) {
      pending.delete(String(value.id))
      if (cfg.mode === "file-approval") {
        const decision =
          value.result && typeof value.result === "object" && "decision" in value.result
            ? value.result.decision
            : undefined
        notify("item/completed", {
          ...turn,
          item: {
            id: turn.itemId,
            type: "fileChange",
            changes,
            status: decision === "accept" || decision === "acceptForSession" ? "completed" : "declined",
          },
        })
      }
      complete(turn.threadId, turn.turnId)
    }
    continue
  }
  const respond = (result: unknown) => write({ id: value.id, result })
  const params = value.params ?? {}
  if (value.method === "initialize") {
    respond({ userAgent: "codex-fixture/1.0.0" })
    continue
  }
  if (value.method === "initialized") continue
  if (value.method === "account/read") {
    respond({ account: { type: "chatgpt" }, requiresOpenaiAuth: true })
    continue
  }
  if (value.method === "model/list") {
    respond({
      data: [
        {
          id: "native-model",
          model: "native-model",
          displayName: "Native model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
          defaultReasoningEffort: "medium",
        },
        {
          id: "text-model",
          model: "text-model",
          displayName: "Text model",
          isDefault: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
        },
      ],
      nextCursor: null,
    })
    continue
  }
  if (value.method === "thread/loaded/list") {
    respond({ data: [...threads.keys()], nextCursor: null })
    continue
  }
  if (value.method === "thread/read") {
    const thread = threads.get(String(params.threadId))
    if (!thread) {
      write({ id: value.id, error: { code: -32000, message: "Thread not found" } })
      continue
    }
    respond({ thread })
    continue
  }
  if (value.method === "thread/turns/list") {
    respond({ data: threads.get(String(params.threadId))?.turns ?? [], nextCursor: null })
    continue
  }
  if (value.method === "thread/start" || value.method === "thread/resume") {
    if (cfg.mode === "resume-fail" && value.method === "thread/resume") {
      write({ id: value.id, error: { code: -32000, message: "Thread unavailable" } })
      continue
    }
    const id = typeof params.threadId === "string" ? params.threadId : crypto.randomUUID()
    threads.set(id, {
      id,
      parentThreadId: null,
      sessionId: "fixture-session",
      agentNickname: null,
      status: { type: "idle" },
      turns: [],
    })
    if (value.method === "thread/resume") {
      notify("item/agentMessage/delta", {
        threadId: id,
        turnId: "old-turn",
        itemId: "old-answer",
        delta: "Old resume replay",
      })
    }
    respond({ thread: threads.get(id), model: "native-model" })
    continue
  }
  if (value.method === "turn/interrupt") {
    respond({})
    notify("turn/completed", {
      threadId: params.threadId,
      turn: { id: params.turnId, status: "interrupted", items: [], error: null },
    })
    continue
  }
  if (value.method !== "turn/start") {
    write({ id: value.id, error: { code: -32601, message: "Unknown method" } })
    continue
  }
  const threadId = String(params.threadId)
  const turnId = crypto.randomUUID()
  const thread = threads.get(threadId)
  if (thread) {
    thread.status.type = "active"
    thread.turns = [{ id: turnId, status: "inProgress", items: [] }]
  }
  notify("turn/started", { threadId, turn: { id: turnId } })
  respond({ turn: { id: turnId } })
  notify("item/agentMessage/delta", { threadId: "another-thread", turnId, itemId: "foreign", delta: "Must not appear" })
  notify("item/agentMessage/delta", { threadId, turnId: "another-turn", itemId: "stale", delta: "Must not appear" })
  if (cfg.mode === "crash") process.exit(3)
  if (cfg.mode === "fail") {
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", items: [], error: { message: "Model unavailable" } },
    })
    continue
  }
  if (cfg.mode === "interrupted-tool") {
    notify("item/completed", {
      threadId,
      turnId,
      item: { id: "wait", type: "collabAgentToolCall", tool: "wait", status: "interrupted", receiverThreadIds: [] },
    })
    complete(threadId, turnId)
    continue
  }
  if (cfg.mode === "subagent" || cfg.mode === "subagent-running") {
    const child = {
      id: "child-thread",
      parentThreadId: threadId,
      sessionId: "fixture-session",
      agentNickname: "Evidence reader",
      status: { type: "active" },
      turns: [],
    }
    threads.set(child.id, child)
    const spawn = {
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: threadId,
      receiverThreadIds: [child.id],
      status: "completed",
    }
    notify("item/completed", { threadId, turnId, item: spawn })
    const childturn = crypto.randomUUID()
    notify("turn/started", { threadId: child.id, turn: { id: childturn } })
    const grandchild = {
      id: "grandchild-thread",
      parentThreadId: child.id,
      sessionId: "fixture-session",
      agentNickname: "Equation checker",
      status: { type: "active" },
      turns: [],
    }
    if (cfg.mode === "subagent-running") {
      threads.set(grandchild.id, grandchild)
      notify("item/completed", {
        threadId: child.id,
        turnId: childturn,
        item: { ...spawn, senderThreadId: child.id, receiverThreadIds: [grandchild.id] },
      })
    }
    const target = cfg.mode === "subagent-running" ? grandchild.id : child.id
    const targetturn = cfg.mode === "subagent-running" ? crypto.randomUUID() : childturn
    if (target === grandchild.id) notify("turn/started", { threadId: target, turn: { id: targetturn } })
    notify("item/started", {
      threadId: target,
      turnId: targetturn,
      item: { id: "command", type: "commandExecution", command: "echo evidence", cwd: root, status: "inProgress" },
    })
    const id = crypto.randomUUID()
    pending.set(id, { threadId: target, turnId: targetturn, itemId: "command" })
    write({
      id,
      method: "item/commandExecution/requestApproval",
      params: { threadId: target, turnId: targetturn, itemId: "command", command: "echo evidence", cwd: root },
    })
    if (cfg.mode === "subagent") complete(threadId, turnId)
    continue
  }
  if (cfg.mode === "file-approval") {
    const itemId = "file-change"
    notify("item/started", {
      threadId,
      turnId,
      item: { id: itemId, type: "fileChange", changes, status: "inProgress" },
    })
    const id = crypto.randomUUID()
    pending.set(id, { threadId, turnId, itemId })
    write({
      id,
      method: "item/fileChange/requestApproval",
      params: { threadId, turnId, itemId, reason: "Update the paper" },
    })
    continue
  }
  if (cfg.mode?.startsWith("approval-")) {
    const itemId = "review-command"
    const stdin = cfg.mode.includes("stdin")
    if (
      !["approval-missing", "approval-stdin-missing-item", "approval-network", "approval-network-invalid"].includes(
        cfg.mode,
      )
    ) {
      notify("item/started", {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: "commandExecution",
          command: "python -i",
          cwd: root,
          processId: "123",
          status: "inProgress",
        },
      })
    }
    const id = crypto.randomUUID()
    pending.set(id, { threadId, turnId, itemId })
    write({
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId,
        kind: cfg.mode === "approval-kind" ? "unknown" : stdin ? "writeStdin" : "command",
        reason: "Please approve the requested action",
        command:
          stdin && cfg.mode !== "approval-stdin-missing-input" ? "write_stdin --session-id 123 'print(42)'" : null,
        cwd: null,
        environmentId: "remote-research-host",
        ...(cfg.mode.startsWith("approval-network")
          ? {
              networkApprovalContext: {
                host: cfg.mode === "approval-network" ? "api.example.test" : "",
                protocol: "https",
              },
            }
          : {}),
        availableDecisions: ["accept", "cancel"],
      },
    })
    continue
  }
  const command = {
    id: "command",
    type: "commandExecution",
    command: "echo native",
    cwd: root,
    status: "inProgress",
    aggregatedOutput: null,
  }
  notify("item/started", { threadId, turnId, item: command })
  notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: command.id, delta: "native\n" })
  if (cfg.mode === "approval" || cfg.mode === "question" || cfg.mode === "withdrawal") {
    const id = crypto.randomUUID()
    pending.set(id, { threadId, turnId, itemId: command.id })
    write({
      id,
      method: cfg.mode !== "question" ? "item/commandExecution/requestApproval" : "item/tool/requestUserInput",
      params: {
        threadId,
        turnId,
        itemId: command.id,
        command: "echo native",
        cwd: root,
        ...(cfg.mode !== "question"
          ? { availableDecisions: ["accept", "decline", "cancel"] }
          : {
              questions: [
                {
                  id: "paper-choice",
                  header: "Paper",
                  question: "Which paper?",
                  isOther: true,
                  options: [{ label: "First", description: "First paper" }],
                },
              ],
            }),
      },
    })
    if (cfg.mode === "withdrawal") {
      const timer = setInterval(async () => {
        if (!(await Bun.file(path.join(root, "withdraw-approval")).exists())) return
        clearInterval(timer)
        pending.delete(id)
        notify("serverRequest/resolved", { threadId, requestId: id })
        const next = crypto.randomUUID()
        pending.set(next, { threadId, turnId, itemId: command.id })
        write({
          id: next,
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, itemId: command.id, command: "echo replacement", cwd: root },
        })
      }, 20)
    }
    continue
  }
  notify("item/completed", {
    threadId,
    turnId,
    item: { ...command, status: "completed", aggregatedOutput: "native\n", exitCode: 0 },
  })
  notify("item/started", { threadId, turnId, item: { id: "reason", type: "reasoning", summary: [], content: [] } })
  notify("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: "reason", delta: "Checking evidence." })
  notify("item/completed", {
    threadId,
    turnId,
    item: { id: "reason", type: "reasoning", summary: ["Checking evidence."], content: [] },
  })
  complete(threadId, turnId)
}
