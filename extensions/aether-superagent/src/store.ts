import { Database } from "bun:sqlite"
import type { Research, ResearchEvent } from "./research"

export type Ticket = {
  id: string
  title: string
  session: string
  directory: string
  state: "queued" | "running" | "waiting" | "attention" | "stopped"
  result: string
}

export type Input = {
  id: string
  key: string
  text: string
  mode: "route" | "work"
  ticket: string | null
  message: string
  state: "pending" | "dispatching" | "done" | "uncertain" | "cancelled"
  result: string
}

// Match Aether's time-ordered message IDs, including its 48-bit timestamp encoding.
let counter = 0
export function id(prefix: string) {
  const raw = (BigInt(Date.now()) << 12n) + BigInt(counter++ % 4096)
  const time = ((prefix === "ses" ? ~raw : raw) & ((1n << 48n) - 1n)).toString(16).padStart(12, "0")
  return `${prefix}_${time}${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`
}

export class Store {
  readonly db: Database

  constructor(file: string) {
    this.db = new Database(file, { create: true })
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ticket (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, session TEXT NOT NULL UNIQUE,
        directory TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS input (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, mode TEXT NOT NULL,
        ticket TEXT REFERENCES ticket(id), message TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL, result TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research (ticket TEXT PRIMARY KEY REFERENCES ticket(id), snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL REFERENCES ticket(id),
        input TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_master (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_run (id TEXT PRIMARY KEY REFERENCES input(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_report (id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES native_run(id), revision INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(run,revision));
      CREATE TABLE IF NOT EXISTS native_outbox (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_schedule (id TEXT PRIMARY KEY REFERENCES native_master(id), data TEXT NOT NULL);
    `)
  }

  atomic<T>(fn: () => T) {
    return this.db.transaction(fn).immediate()
  }

  tickets() {
    return this.db.query<Ticket, []>("SELECT * FROM ticket ORDER BY rowid").all()
  }

  ticket(id: string) {
    return this.db.query<Ticket, [string]>("SELECT * FROM ticket WHERE id = ?").get(id)
  }

  inputs() {
    return this.db.query<Input, []>("SELECT * FROM input ORDER BY rowid").all()
  }

  input(id: string) {
    return this.db.query<Input, [string]>("SELECT * FROM input WHERE id = ?").get(id)
  }

  byKey(key: string) {
    return this.db.query<Input, [string]>("SELECT * FROM input WHERE key = ?").get(key)
  }

  research(ticket: string): Research | null {
    const row = this.db.query<{ snapshot: string }, [string]>("SELECT snapshot FROM research WHERE ticket=?").get(ticket)
    return row ? JSON.parse(row.snapshot) as Research : null
  }

  recordResearch(ticket: string, research: Research, kind: ResearchEvent["kind"]) {
    this.atomic(() => {
      const snapshot = JSON.stringify(research)
      this.db.query("INSERT INTO research VALUES (?,?) ON CONFLICT(ticket) DO UPDATE SET snapshot=excluded.snapshot").run(ticket, snapshot)
      this.db.query("INSERT INTO research_event(ticket,input,kind,at,snapshot) VALUES (?,?,?,?,?)")
        .run(ticket, research.input, kind, Date.now(), snapshot)
    })
  }

  events(ticket?: string, limit = 100): ResearchEvent[] {
    const count = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = ticket
      ? this.db.query<{ id: number; ticket: string; input: string | null; kind: ResearchEvent["kind"]; at: number; snapshot: string }, [string, number]>("SELECT * FROM research_event WHERE ticket=? ORDER BY id DESC LIMIT ?").all(ticket, count)
      : this.db.query<{ id: number; ticket: string; input: string | null; kind: ResearchEvent["kind"]; at: number; snapshot: string }, [number]>("SELECT * FROM research_event ORDER BY id DESC LIMIT ?").all(count)
    return rows.reverse().map(({ snapshot, ...event }) => ({ ...event, research: JSON.parse(snapshot) as Research }))
  }

  save(ticket: Ticket) {
    this.db.query(`INSERT INTO ticket VALUES ($id,$title,$session,$directory,$state,$result)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, result=excluded.result`).run({
      $id: ticket.id, $title: ticket.title, $session: ticket.session,
      $directory: ticket.directory, $state: ticket.state, $result: ticket.result,
    })
  }

  put(input: Input) {
    this.db.query(`INSERT INTO input VALUES ($id,$key,$text,$mode,$ticket,$message,$state,$result)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, result=excluded.result,
        ticket=excluded.ticket, mode=excluded.mode, text=excluded.text`).run({
      $id: input.id, $key: input.key, $text: input.text, $mode: input.mode,
      $ticket: input.ticket, $message: input.message, $state: input.state, $result: input.result,
    })
  }

  setting(key: string, value?: string) {
    if (value !== undefined)
      this.db.query("INSERT INTO setting VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value)
    return this.db.query<{ value: string }, [string]>("SELECT value FROM setting WHERE key=?").get(key)?.value
  }

  recover() {
    this.atomic(() => {
      this.db.query("UPDATE input SET state='uncertain', result='Coordinator restarted; reconcile before repeating work.' WHERE state='dispatching'").run()
      this.db.query("UPDATE ticket SET state='attention' WHERE state='running'").run()
    })
  }
}
