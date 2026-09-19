import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"

export function hash(value) {
  return createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex")
}

export class Store {
  constructor(dir) {
    this.dir = dir
    mkdirSync(path.join(dir, "blobs"), { recursive: true, mode: 0o700 })
    this.db = new Database(path.join(dir, "state.sqlite"))
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session TEXT UNIQUE NOT NULL, epoch INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, time INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, run TEXT NOT NULL, epoch INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `)
  }

  run(session) {
    const row = this.db.query("SELECT data FROM runs WHERE session = ?").get(session)
    return row && JSON.parse(row.data)
  }

  byId(id) {
    const row = this.db.query("SELECT data FROM runs WHERE id = ?").get(id)
    return row && JSON.parse(row.data)
  }

  latest() {
    const row = this.db.query("SELECT data FROM runs ORDER BY rowid DESC LIMIT 1").get()
    return row && JSON.parse(row.data)
  }

  create(session) {
    const run = {
      id: randomUUID(),
      session,
      epoch: 0,
      round: 0,
      cycle: 0,
      phase: "new",
      calls: 0,
      history: [],
      pending: [],
      assets: [],
      assumptions: [],
      questions: [],
      contract: null,
      plan: null,
      planInvalid: false,
      // v3 state: milestone registry, conclusion-level ledger, verifier registry,
      // per-subproblem results. All milestones/reviews live in the run row; the
      // frontier machine is a pure projection of this state and can be rebuilt
      // from disk after any interruption.
      milestones: {},
      ledger: [],
      verifiers: {},
      subresults: {},
      subreports: {},
      feedback: null,
    }
    this.db.query("INSERT INTO runs VALUES (?, ?, ?, ?)").run(run.id, session, 0, JSON.stringify(run))
    this.event(run, "created", {})
    return run
  }

  save(run, expected = run.epoch) {
    const result = this.db
      .query("UPDATE runs SET epoch = ?, data = ? WHERE id = ? AND epoch = ?")
      .run(run.epoch, JSON.stringify(run), run.id, expected)
    if (result.changes !== 1) throw new Error("STALE: run epoch changed")
  }

  event(run, kind, data) {
    if (this.report) {
      try {
        this.report(run, kind, data)
      } catch {}
    }
    this.db
      .query("INSERT INTO events (run, time, kind, data) VALUES (?, ?, ?, ?)")
      .run(run.id, Date.now(), kind, JSON.stringify(data))
  }

  move(run, phase, data = {}) {
    const transitions = {
      new: ["contract"],
      contract: ["planning", "needs_human"],
      planning: ["working", "needs_human"],
      working: ["working", "planning", "integrating", "needs_human"],
      integrating: ["awaiting_human", "working", "needs_human"],
      awaiting_human: ["accepted", "contract"],
      accepted: ["contract"],
      unfinished: ["contract", "planning", "working", "integrating"],
      cancelled: ["contract", "planning", "working", "integrating"],
      needs_human: ["contract", "planning", "working", "needs_human"],
    }
    const recovery = ["contract", "planning", "working", "integrating"].includes(phase)
    if (!["unfinished", "cancelled"].includes(phase) && !recovery && !transitions[run.phase]?.includes(phase))
      throw new Error(`Illegal workflow transition ${run.phase} -> ${phase}`)
    if (
      phase === "awaiting_human" &&
      (!run.delivery ||
        !run.summary ||
        !run.integrated ||
        Object.values(run.milestones).some((m) => m.status === "failed" || m.status === "in_review"))
    )
      throw new Error("Delivery gate requires an integrated report with no failed or in-review milestones")
    this.db.transaction(() => {
      run.phase = phase
      try {
        this.save(run)
      } catch {
        this.event(run, "superseded_transition", { phase, round: run.round, cycle: run.cycle })
        return
      }
      this.event(run, "phase", { phase, round: run.round, cycle: run.cycle, ...data })
    })()
  }

  put(run, kind, name, content, metadata = {}) {
    const digest = hash(content)
    const id = `${kind}:${hash({ run: run.id, round: run.round, kind, name, digest, metadata })}`
    const file = path.join(this.dir, "blobs", digest)
    if (!existsSync(file)) writeFileSync(file, content, { flag: "wx", mode: 0o600 })
    const asset = {
      id,
      run: run.id,
      round: run.round,
      kind,
      name,
      hash: digest,
      bytes: Buffer.byteLength(content),
      ...metadata,
    }
    this.db.query("INSERT OR IGNORE INTO assets VALUES (?, ?)").run(id, JSON.stringify(asset))
    if (!run.assets.includes(id)) run.assets.push(id)
    this.save(run)
    return asset
  }

  // 元数据查询：不做 blob 完整性与哈希校验（仅用于名称索引等调度热路径；
  // 引用解析与证据读取仍走 asset() 的完整性校验）。
  metadata(id) {
    const row = this.db.query("SELECT data FROM assets WHERE id = ?").get(id)
    if (!row) throw new Error(`Unknown asset ${id}`)
    return JSON.parse(row.data)
  }

  asset(id) {
    const row = this.db.query("SELECT data FROM assets WHERE id = ?").get(id)
    if (!row) throw new Error(`Unknown asset ${id}`)
    const asset = JSON.parse(row.data)
    const content = readFileSync(path.join(this.dir, "blobs", asset.hash))
    if (hash(content) !== asset.hash) throw new Error(`Asset changed: ${id}`)
    return { ...asset, content: content.toString("utf8") }
  }

  job(run, job, status, data = {}) {
    const edges = {
      queued: ["preparing"],
      preparing: ["running", "error", "cancelled", "stale", "interrupted"],
      running: ["checking", "timeout", "error", "cancelled", "stale", "interrupted"],
      checking: ["accepted", "rejected", "error", "stale", "cancelled", "correcting", "interrupted"],
      correcting: [
        "checking",
        "accepted",
        "rejected",
        "timeout",
        "error",
        "stale",
        "cancelled",
        "exhausted",
        "interrupted",
      ],
      rejected: ["retrying", "exhausted"],
      timeout: ["retrying", "exhausted"],
      retrying: [],
      accepted: [],
      error: [],
      stale: [],
      cancelled: [],
      exhausted: [],
      // interrupted：实例/进程中断遗留的可续传态——会话与目录保留，
      // 下次同 packet 调度时原会话续传（runner resume）；packet/epoch 已
      // 变化的续传候选直接归档为 stale
      interrupted: ["queued", "preparing", "stale"],
    }
    if (job.status && !edges[job.status]?.includes(status))
      throw new Error(`Illegal supervisor transition ${job.status} -> ${status}`)
    if (!job.status && status !== "queued") throw new Error("Job must start queued")
    Object.assign(job, data, { status })
    this.db.transaction(() => {
      this.db
        .query("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?)")
        .run(job.id, run.id, job.epoch ?? run.epoch, JSON.stringify(job))
      this.event(run, "job", { ...job })
    })()
  }

  jobs(run) {
    return this.db
      .query("SELECT data FROM jobs WHERE run = ? ORDER BY rowid")
      .all(run.id)
      .map((row) => JSON.parse(row.data))
  }

  events(run) {
    return this.db
      .query("SELECT * FROM events WHERE run = ? ORDER BY seq")
      .all(run.id)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }))
  }
}
