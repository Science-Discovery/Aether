import type { Message, Part, Session, TextPart } from "@opencode-ai/sdk/v2"

export type BranchTreeRow = {
  id: string
  parentID?: string
  title: string
  previewText: string
  isCurrent: boolean
  depth: number
  children: string[]
  rowIndex: number
  lane: number
  colorIndex: number
  parentRowIndex?: number
}

type BuildBranchTreeRowsInput = {
  currentSessionID?: string
  treeSessions?: Session[]
  allSessions?: Session[]
  messagesBySession?: Record<string, Message[] | undefined>
  partsByMessage?: Record<string, Part[] | undefined>
  previewPlaceholder?: string
}

export type BranchTreeRowsResult = {
  rootIDs: string[]
  rows: BranchTreeRow[]
}

const isTextPart = (part: Part): part is TextPart => part.type === "text"

const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim()

function serializePart(part: Part) {
  const { id, sessionID, messageID, time, ...rest } = part as Part & {
    id?: string
    sessionID?: string
    messageID?: string
    time?: unknown
  }
  return JSON.stringify(rest)
}

function messageFingerprint(message: Message, parts: Part[] | undefined) {
  return JSON.stringify({
    role: message.role,
    parts: (parts ?? []).map(serializePart),
  })
}

function firstVisibleUserText(message: Message, partsByMessage: Record<string, Part[] | undefined>) {
  if (message.role !== "user") return
  const text = (partsByMessage[message.id] ?? [])
    .filter((part): part is TextPart => isTextPart(part) && !part.synthetic)
    .map((part) => normalizeText(part.text))
    .filter(Boolean)
    .join(" ")

  return text || undefined
}

function commonPrefixLength(
  parentMessages: Message[] | undefined,
  childMessages: Message[] | undefined,
  partsByMessage: Record<string, Part[] | undefined>,
) {
  const parent = parentMessages ?? []
  const child = childMessages ?? []
  const total = Math.min(parent.length, child.length)
  let index = 0

  while (index < total) {
    const parentFingerprint = messageFingerprint(parent[index], partsByMessage[parent[index].id])
    const childFingerprint = messageFingerprint(child[index], partsByMessage[child[index].id])
    if (parentFingerprint !== childFingerprint) break
    index += 1
  }

  return index
}

export function getBranchPreviewText(input: {
  session: Session
  sessionsByID: Map<string, Session>
  messagesBySession?: Record<string, Message[] | undefined>
  partsByMessage?: Record<string, Part[] | undefined>
  previewPlaceholder: string
}) {
  const messagesBySession = input.messagesBySession ?? {}
  const partsByMessage = input.partsByMessage ?? {}
  const ownMessages = messagesBySession[input.session.id] ?? []
  const parentSession = input.session.parentID ? input.sessionsByID.get(input.session.parentID) : undefined
  const startIndex =
    parentSession && ownMessages.length > 0
      ? commonPrefixLength(messagesBySession[parentSession.id], ownMessages, partsByMessage)
      : 0

  for (const message of ownMessages.slice(startIndex)) {
    const text = firstVisibleUserText(message, partsByMessage)
    if (text) return text
  }

  return input.previewPlaceholder
}

function sortSessions(a: Session, b: Session) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

function buildChildrenByParent(sessions: Session[]) {
  const map = new Map<string, Session[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const current = map.get(session.parentID)
    if (current) current.push(session)
    else map.set(session.parentID, [session])
  }

  for (const children of map.values()) children.sort(sortSessions)
  return map
}

function findRootIDs(treeSessions: Session[], treeSessionIDs: Set<string>) {
  return [...treeSessions]
    .filter((session) => !session.parentID || !treeSessionIDs.has(session.parentID))
    .sort(sortSessions)
    .map((session) => session.id)
}

export function buildBranchTreeRows(input: BuildBranchTreeRowsInput): BranchTreeRowsResult {
  const treeSessions = [...(input.treeSessions ?? [])].sort(sortSessions)
  if (!input.currentSessionID || treeSessions.length === 0) return { rootIDs: [], rows: [] }

  const treeSessionIDs = new Set(treeSessions.map((session) => session.id))
  const treeSessionsByID = new Map(treeSessions.map((session) => [session.id, session]))
  const allSessionsByID = new Map((input.allSessions ?? treeSessions).map((session) => [session.id, session]))
  const childrenByParent = buildChildrenByParent(treeSessions)
  const rootIDs = findRootIDs(treeSessions, treeSessionIDs)
  const rows: BranchTreeRow[] = []
  let nextLane = 0

  const visit = (sessionID: string, depth: number, lane: number, parentRowIndex?: number) => {
    const session = treeSessionsByID.get(sessionID)
    if (!session) return

    const children = childrenByParent.get(sessionID) ?? []
    const rowIndex = rows.length
    rows.push({
      id: session.id,
      parentID: session.parentID,
      title: session.title,
      previewText: getBranchPreviewText({
        session,
        sessionsByID: allSessionsByID,
        messagesBySession: input.messagesBySession,
        partsByMessage: input.partsByMessage,
        previewPlaceholder: input.previewPlaceholder ?? "No messages yet",
      }),
      isCurrent: session.id === input.currentSessionID,
      depth,
      children: children.map((child) => child.id),
      rowIndex,
      lane,
      colorIndex: lane,
      parentRowIndex,
    })

    if (children.length === 0) return

    const mainline = children[children.length - 1]
    for (const child of children.slice(0, -1)) {
      nextLane += 1
      visit(child.id, depth + 1, nextLane, rowIndex)
    }
    visit(mainline.id, depth + 1, lane, rowIndex)
  }

  for (const rootID of rootIDs) {
    const lane = nextLane
    visit(rootID, 0, lane)
    nextLane += 1
  }

  return { rootIDs, rows }
}
