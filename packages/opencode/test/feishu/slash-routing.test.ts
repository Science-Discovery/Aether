import { describe, expect, test } from "bun:test"
import { classifySlashCommand, type SlashRoutingState, type SlashRoute } from "../../src/feishu/manager"

const idle: SlashRoutingState = {
  activePrompt: false,
  pendingQuestion: false,
  pendingPermission: false,
  hasSession: true,
}

const busy: SlashRoutingState = {
  activePrompt: true,
  pendingQuestion: false,
  pendingPermission: false,
  hasSession: true,
}

const pendingQ: SlashRoutingState = {
  activePrompt: false,
  pendingQuestion: true,
  pendingPermission: false,
  hasSession: true,
}

const pendingP: SlashRoutingState = {
  activePrompt: false,
  pendingQuestion: false,
  pendingPermission: true,
  hasSession: true,
}

const busyAndPendingQ: SlashRoutingState = {
  activePrompt: true,
  pendingQuestion: true,
  pendingPermission: false,
  hasSession: true,
}

const noSession: SlashRoutingState = {
  activePrompt: false,
  pendingQuestion: false,
  pendingPermission: false,
  hasSession: false,
}

describe("classifySlashCommand — /help", () => {
  test("/help → help, not full", () => {
    expect(classifySlashCommand("/help", idle)).toEqual({ action: "help", full: false })
  })

  test("/help list → help, full", () => {
    expect(classifySlashCommand("/help list", idle)).toEqual({ action: "help", full: true })
  })

  test("/h → help, not full", () => {
    expect(classifySlashCommand("/h", idle)).toEqual({ action: "help", full: false })
  })

  test("/help不受busy/pending影响", () => {
    expect(classifySlashCommand("/help", busy)).toEqual({ action: "help", full: false })
    expect(classifySlashCommand("/h", pendingQ)).toEqual({ action: "help", full: false })
    expect(classifySlashCommand("/help list", pendingP)).toEqual({ action: "help", full: true })
  })
})

describe("classifySlashCommand — general commands (no busy check)", () => {
  const commands = [
    "/new",
    "/n",
    "/model",
    "/model list",
    "/m 1",
    "/m l",
    "/agent",
    "/a build",
    "/a 1",
    "/project",
    "/p l",
    "/p 1",
    "/session",
    "/s l",
    "/s 1",
    "/variant",
    "/variant 1",
    "/autoaccept",
    "/autoaccept 1",
  ]

  for (const cmd of commands) {
    test(`${cmd} — idle → command`, () => {
      const route = classifySlashCommand(cmd, idle)
      expect(route.action).toBe("command")
    })

    test(`${cmd} — busy → still command (不受繁忙影响)`, () => {
      const route = classifySlashCommand(cmd, busy)
      expect(route.action).toBe("command")
    })

    test(`${cmd} — pendingQuestion → still command (不受pending影响)`, () => {
      const route = classifySlashCommand(cmd, pendingQ)
      expect(route.action).toBe("command")
    })
  }
})

describe("classifySlashCommand — /stop", () => {
  test("/stop idle → stop_idle", () => {
    expect(classifySlashCommand("/stop", idle)).toEqual({ action: "stop_idle" })
  })

  test("/stop noSession → stop_idle", () => {
    expect(classifySlashCommand("/stop", noSession)).toEqual({ action: "stop_idle" })
  })

  test("/stop busy → stop", () => {
    expect(classifySlashCommand("/stop", busy)).toEqual({ action: "stop" })
  })

  test("/stop pendingQuestion → stop", () => {
    expect(classifySlashCommand("/stop", pendingQ)).toEqual({ action: "stop" })
  })

  test("/stop pendingPermission → stop", () => {
    expect(classifySlashCommand("/stop", pendingP)).toEqual({ action: "stop" })
  })

  test("/stop busy+pendingQ → stop", () => {
    expect(classifySlashCommand("/stop", busyAndPendingQ)).toEqual({ action: "stop" })
  })
})

describe("classifySlashCommand — /compact", () => {
  test("/compact idle → compact", () => {
    expect(classifySlashCommand("/compact", idle)).toEqual({ action: "compact" })
  })

  test("/c idle → compact", () => {
    expect(classifySlashCommand("/c", idle)).toEqual({ action: "compact" })
  })

  test("/compact busy → busy_reply, prompt_active", () => {
    expect(classifySlashCommand("/compact", busy)).toEqual({ action: "busy_reply", reason: "prompt_active" })
  })

  test("/c busy → busy_reply, prompt_active", () => {
    expect(classifySlashCommand("/c", busy)).toEqual({ action: "busy_reply", reason: "prompt_active" })
  })

  test("/compact pendingQuestion → busy_reply, pending_question", () => {
    expect(classifySlashCommand("/compact", pendingQ)).toEqual({ action: "busy_reply", reason: "pending_question" })
  })

  test("/compact pendingPermission → busy_reply, pending_permission", () => {
    expect(classifySlashCommand("/compact", pendingP)).toEqual({ action: "busy_reply", reason: "pending_permission" })
  })

  test("/compact noSession → compact_no_session", () => {
    expect(classifySlashCommand("/compact", noSession)).toEqual({ action: "compact_no_session" })
  })

  test("/c noSession → compact_no_session", () => {
    expect(classifySlashCommand("/c", noSession)).toEqual({ action: "compact_no_session" })
  })
})

describe("classifySlashCommand — normal message (not slash)", () => {
  test("normal text idle → start_prompt", () => {
    expect(classifySlashCommand("hello", idle)).toEqual({ action: "start_prompt" })
  })

  test("normal text busy → normal_busy, prompt_active", () => {
    expect(classifySlashCommand("hello", busy)).toEqual({ action: "normal_busy", reason: "prompt_active" })
  })

  test("normal text pendingQuestion → normal_busy, pending_question", () => {
    expect(classifySlashCommand("hello", pendingQ)).toEqual({ action: "normal_busy", reason: "pending_question" })
  })

  test("normal text pendingPermission → normal_busy, pending_permission", () => {
    expect(classifySlashCommand("hello", pendingP)).toEqual({ action: "normal_busy", reason: "pending_permission" })
  })
})

describe("classifySlashCommand — command parsing", () => {
  test("/new with extra spaces → command", () => {
    const route = classifySlashCommand("/new  ", idle)
    expect(route.action).toBe("command")
    if (route.action === "command") {
      expect(route.cmd).toBe("/new")
      expect(route.rest).toBe("")
    }
  })

  test("/model list → command with rest 'list'", () => {
    const route = classifySlashCommand("/model list", idle)
    expect(route.action).toBe("command")
    if (route.action === "command") {
      expect(route.cmd).toBe("/model")
      expect(route.rest).toBe("list")
    }
  })

  test("/a build → command with rest 'build'", () => {
    const route = classifySlashCommand("/a build", idle)
    expect(route.action).toBe("command")
    if (route.action === "command") {
      expect(route.cmd).toBe("/a")
      expect(route.rest).toBe("build")
    }
  })
})

describe("classifySlashCommand — decision matrix summary", () => {
  const matrix: { input: string; state: SlashRoutingState; expectedAction: SlashRoute["action"] }[] = [
    { input: "/help", state: idle, expectedAction: "help" },
    { input: "/help", state: busy, expectedAction: "help" },
    { input: "/help", state: pendingQ, expectedAction: "help" },
    { input: "/help", state: pendingP, expectedAction: "help" },
    { input: "/new", state: idle, expectedAction: "command" },
    { input: "/new", state: busy, expectedAction: "command" },
    { input: "/new", state: pendingQ, expectedAction: "command" },
    { input: "/new", state: pendingP, expectedAction: "command" },
    { input: "/stop", state: idle, expectedAction: "stop_idle" },
    { input: "/stop", state: busy, expectedAction: "stop" },
    { input: "/stop", state: pendingQ, expectedAction: "stop" },
    { input: "/stop", state: pendingP, expectedAction: "stop" },
    { input: "/compact", state: idle, expectedAction: "compact" },
    { input: "/compact", state: busy, expectedAction: "busy_reply" },
    { input: "/compact", state: pendingQ, expectedAction: "busy_reply" },
    { input: "/compact", state: pendingP, expectedAction: "busy_reply" },
    { input: "/compact", state: noSession, expectedAction: "compact_no_session" },
    { input: "/model", state: idle, expectedAction: "command" },
    { input: "/model", state: busy, expectedAction: "command" },
    { input: "/agent", state: idle, expectedAction: "command" },
    { input: "/agent", state: busy, expectedAction: "command" },
    { input: "/project", state: idle, expectedAction: "command" },
    { input: "/project", state: busy, expectedAction: "command" },
    { input: "/session", state: idle, expectedAction: "command" },
    { input: "/session", state: busy, expectedAction: "command" },
    { input: "/variant", state: idle, expectedAction: "command" },
    { input: "/variant", state: busy, expectedAction: "command" },
    { input: "/autoaccept", state: idle, expectedAction: "command" },
    { input: "/autoaccept", state: busy, expectedAction: "command" },
    { input: "普通文本", state: idle, expectedAction: "start_prompt" },
    { input: "普通文本", state: busy, expectedAction: "normal_busy" },
  ]

  for (const { input, state, expectedAction } of matrix) {
    test(`"${input}" → ${expectedAction}`, () => {
      expect(classifySlashCommand(input, state).action).toBe(expectedAction)
    })
  }
})
