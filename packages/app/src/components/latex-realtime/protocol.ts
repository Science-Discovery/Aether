// Adapted from realtime-tex-vsc-plugin (MIT), which mirrors the rtex serve JSON protocol.
export type Sp = number

export interface Versions {
  source_revision: number
  context_revision: number
  engine_generation: number
  layout_version: number
}

export interface FontDesc {
  id: number
  name?: string | null
  fullname?: string | null
  psname?: string | null
  filename?: string | null
  format?: string | null
  type?: string | null
  size?: number | null
  designsize?: number | null
  slant?: number | null
  extend?: number | null
  squeeze?: number | null
  subfont?: number | null
}

export type Item = [string, ...unknown[]]

export interface Line {
  par?: number
  i?: number
  unit?: number
  row?: number
  x: Sp
  y: Sp
  w: Sp
  h: Sp
  d: Sp
  items: Item[]
}

export interface ImageInfo {
  file: string
  page?: number
  pages?: number
  cached_picture?: boolean
  bbox?: [number, number, number, number]
}

export interface DisplayList {
  kind: string
  fonts: Record<string, FontDesc>
  lines: Line[]
  other: Item[]
  flags: unknown
  glyphs?: number
  inserts?: number
  images_info?: Record<string, ImageInfo>
  width: Sp
  height: Sp
  depth: Sp
  page?: number | null
  page_width?: Sp
  page_height?: Sp
}

export interface Fragment {
  page: number
  first_line: number
  last_line: number
  x: Sp
  xs: Sp[]
  baselines: Sp[]
  approximate: boolean
}

export interface Placement {
  par_id: number
  fragments: Fragment[]
  lines: number
  kind: string
}

export interface PageUpdate {
  page: number
  exact: boolean
  hash: number
  dl: DisplayList
}

export type Convergence =
  | { state: "Converged" }
  | { state: "Converging"; pass: number; reasons: string[] }
  | { state: "PassLimitReached"; passes: number; reasons: string[] }
  | { state: "Stale"; pending_since: number }

export type CompileStatus = { state: "Ok" } | { state: "CompiledWithErrors"; count: number } | { state: "Failed" }

export interface Diagnostic {
  severity: string
  file?: string | null
  line?: number | null
  message: string
  context?: string | null
}

export interface Timing {
  total_us: number
  tex_us: number
  traverse_us: number
  pack_us: number
}

export interface ParagraphUpdateEvent {
  event: "ParagraphUpdate"
  par_id: number
  edit_id: number
  versions: Versions
  status: string
  reasons: string[]
  fragments: Fragment[]
  pagination_stale: boolean
  context_stale: boolean
  dl: DisplayList
  diagnostics: Diagnostic[]
  timing: Timing
}

export interface LayoutUpdateEvent {
  event: "LayoutUpdate"
  versions: Versions
  compile: CompileStatus
  convergence: Convergence
  passes: number
  pages_changed: PageUpdate[]
  pages_total: number
  placements: Placement[]
  eligible_paragraphs: number[]
  pdf_fallback: string | null
  wall_ms: number
}

export interface DiagnosticsEvent {
  event: "Diagnostics"
  source: string
  items: Diagnostic[]
}

export interface EngineStateEvent {
  event: "EngineState"
  engine_generation: number
  state: string
  reason: string | null
}

export interface BackgroundScheduledEvent {
  event: "BackgroundScheduled"
  par_id: number | null
  reasons: string[]
  edit_id: number
}

export type RtexEvent =
  | ParagraphUpdateEvent
  | LayoutUpdateEvent
  | DiagnosticsEvent
  | EngineStateEvent
  | BackgroundScheduledEvent
  | { event: "Ping" }
  | { event: "SessionExit"; code: number | null; signal: string | null; stderr: string[] }
  | { event: "SessionError"; message: string }
