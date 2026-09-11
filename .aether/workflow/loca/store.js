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
    this.db
      .query("INSERT INTO events (run, time, kind, data) VALUES (?, ?, ?, ?)")
      .run(run.id, Date.now(), kind, JSON.stringify(data))
  }

  move(run, phase, data = {}) {
    const transitions = {
      new: ["contract"],
      contract: ["solve", "needs_human"],
      solve: ["split", "solve"],
      split: ["structure", "split", "solve"],
      structure: ["inputs", "split", "solve"],
      inputs: ["split", "validate", "solve"],
      validate: ["review", "solve"],
      review: ["integrate", "solve"],
      integrate: ["awaiting_human", "solve"],
      awaiting_human: ["accepted", "contract"],
      accepted: ["contract"],
      unfinished: ["contract", "solve"],
      cancelled: ["contract", "solve"],
      needs_human: ["contract", "needs_human"],
    }
    const recovery = phase === "contract" || phase === "solve"
    if (!["unfinished", "cancelled"].includes(phase) && !recovery && !transitions[run.phase]?.includes(phase))
      throw new Error(`Illegal workflow transition ${run.phase} -> ${phase}`)
    if (
      phase === "awaiting_human" &&
      (!run.delivery ||
        !run.summary ||
        !Object.keys(run.nodes ?? {}).length ||
        Object.values(run.nodes).some((node) => node.effective !== "pass"))
    )
      throw new Error("Delivery gate requires an audited report and effective passing nodes")
    this.db.transaction(() => {
      run.phase = phase
      this.save(run)
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
      preparing: ["running", "error", "cancelled", "stale"],
      running: ["checking", "error", "cancelled", "stale"],
      checking: ["accepted", "rejected", "error", "stale", "cancelled"],
      rejected: ["retrying", "exhausted"],
      retrying: [],
      accepted: [],
      error: [],
      stale: [],
      cancelled: [],
      exhausted: [],
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
