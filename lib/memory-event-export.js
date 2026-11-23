import { createHash, randomBytes } from 'node:crypto'

export const MEMORY_EVENT_EXPORT_SCHEMA = 'echo-memory-event-export/v1'
export const EXPORT_DEFAULT_LIMIT = 50
export const EXPORT_MAX_LIMIT = 100
export const EXPORT_MAX_SOURCE_ROWS = 10000
export const EXPORT_MAX_RESPONSE_BYTES = 256 * 1024

const REF_SALT = randomBytes(16).toString('hex')
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu

const text = value => value === null || value === undefined ? '' : String(value)
const numberOrNull = value => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}
const clip = (value, max = 4096) => text(value).slice(0, max)
const redact = value => clip(value)
  .replace(/file:\/\/\/?[^\s"'<>]+/giu, '[file-uri]')
  .replace(/(?:[A-Za-z]:[\\/]|\\\\)(?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]+(?:\.[A-Za-z0-9]+)?/gu, '[path]')
  .replace(/(?:^|[\s(])\/(?:[^/\s"'<>]+\/)+[^/\s"'<>]+/gu, '[path]')
  .replace(/\bsession-[0-9a-f]{8,}\b/giu, '[session]')
  .replace(/\b(?:memory|episode|edge|node|entity)(?:[_-]?id)?\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9_-]*/giu, '[internal-id]')
  .replace(/\b(?:memory|episode|edge|node|entity)-(?:raw-)?[A-Za-z0-9][A-Za-z0-9_-]*/giu, '[internal-id]')
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '[uuid]')

const refOf = (kind, value) => {
  const digest = createHash('sha256')
    .update(`echo-event-export-v1:${REF_SALT}:${kind}:${text(value)}`)
    .digest('hex')
  return `${kind}-${digest.slice(0, 16)}`
}

const digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function errorOf (code, statusCode = 500) {
  const error = Error(code)
  error.code = code
  error.statusCode = statusCode
  return error
}

function parseLimit (query) {
  const raw = query.get('limit')
  if (raw === null || raw === '') return EXPORT_DEFAULT_LIMIT
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > EXPORT_MAX_LIMIT) {
    throw errorOf('invalid_limit', 400)
  }
  return value
}

function parsePage (query) {
  const raw = query.get('page')
  if (raw === null || raw === '') return 1
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw errorOf('invalid_query', 400)
  return value
}

function decodeCursor (value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || parsed.v !== 1 || !Number.isSafeInteger(parsed.page) || parsed.page < 1
      || typeof parsed.digest !== 'string' || parsed.digest.length !== 64) {
      throw Error()
    }
    return parsed
  } catch {
    throw errorOf('invalid_cursor', 400)
  }
}

function classifySourceError (error) {
  const code = text(error?.code).toUpperCase()
  const message = text(error?.message).toLowerCase()
  if (code.includes('BUSY') || code.includes('LOCKED') || /\b(?:locked|busy)\b/u.test(message)) {
    return 'source_locked'
  }
  if (code.includes('CORRUPT') || code.includes('MALFORMED')
    || /(?:not a database|malformed|corrupt|encrypted)/u.test(message)) {
    return 'source_corrupt'
  }
  if (/(?:no such table|no such column|schema|column)/u.test(message)) {
    return 'schema_incompatible'
  }
  if (code.startsWith('SQLITE_') || /(?:sql|syntax|prepare|query)/u.test(message)) {
    return 'source_sql_failed'
  }
  return 'source_read_failed'
}

function memoryQueryOf (query, page, limit) {
  return {
    page, limit,
    layer: query.get('layer') || '',
    state: query.get('state') || 'active',
    source: query.get('source') || '',
    q: query.get('q') || '',
    sort: query.get('sort') || 'recent'
  }
}

function readMemories (store, options) {
  try {
    return store.listMemories(options)
  } catch (error) {
    throw errorOf(classifySourceError(error), 503)
  }
}

function sourceRows (store, query, page, limit) {
  if (typeof store?.listMemories !== 'function' || typeof store?.graphData !== 'function') {
    throw errorOf('source_unavailable', 503)
  }
  const requested = memoryQueryOf(query, page, limit)
  const memories = readMemories(store, requested)
  if (!memories || !Array.isArray(memories.rows)) throw errorOf('schema_incompatible', 503)
  const total = Number(memories.total) || 0
  if (total > EXPORT_MAX_SOURCE_ROWS) throw errorOf('export_source_budget_exceeded', 413)
  const scanLimit = EXPORT_MAX_LIMIT
  const allMemoryRows = []
  const scanPages = Math.max(1, Math.ceil(total / scanLimit))
  try {
    for (let scanPage = 1; scanPage <= scanPages; scanPage++) {
      const scan = scanPage === page && limit === scanLimit
        ? memories
        : readMemories(store, memoryQueryOf(query, scanPage, scanLimit))
      if (!scan || !Array.isArray(scan.rows)) throw errorOf('schema_incompatible', 503)
      allMemoryRows.push(...scan.rows)
    }
  } catch (error) {
    if (error?.statusCode) throw error
    throw errorOf(classifySourceError(error), 503)
  }
  let graph
  try {
    graph = store.graphData()
  } catch (error) {
    throw errorOf(classifySourceError(error), 503)
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw errorOf('schema_incompatible', 503)
  }
  return { memories, graph, allMemoryRows, query: requested }
}

function buildEpisodes (rows) {
  return rows.map(row => ({
    episodeRef: refOf('episode', row.memoryId),
    ownerRef: null,
    summary: redact(clip(row.summary)),
    sourceQuote: null,
    sourceSession: null,
    sourceChannel: null,
    actor: null,
    speakerRef: null,
    occurredAt: numberOrNull(row.occurredAt),
    recordedAt: numberOrNull(row.timestamp),
    temporalStatus: redact(row.temporalStatus) || 'unknown',
    emotionSnapshot: null,
    confidence: null,
    status: row.status || (row.isActive === false ? 'inactive' : 'active'),
    createdBy: null,
    source: redact(row.source),
    sourceLabel: redact(row.sourceLabel),
    supersededBy: row.supersededBy ? refOf('episode', row.supersededBy) : null
  }))
}

function buildEntities (nodes) {
  return nodes.map(node => ({
    entityRef: refOf('entity', node.id),
    ownerRef: null,
    canonicalName: redact(node.name),
    entityType: redact(node.type) || 'concept',
    aliases: null,
    status: node.isActive === false ? 'inactive' : 'active',
    isActive: node.isActive !== false,
    supersededBy: node.supersededBy ? refOf('entity', node.supersededBy) : null
  }))
}

function buildLegacyEdges (edges) {
  return edges.map(edge => ({
    edgeRef: refOf('edge', edge.id),
    sourceEntityRef: refOf('entity', edge.source),
    targetEntityRef: refOf('entity', edge.target),
    relation: redact(edge.relation),
    status: edge.isActive === false ? 'inactive' : 'active',
    ownerRef: null,
    evidenceRefs: Array.isArray(edge.evidenceIds)
      ? edge.evidenceIds.map(id => refOf('episode', id))
      : [],
    resolution: 'unresolved',
    reason: 'legacy_owner_and_fact_evidence_unavailable',
    occurredAt: numberOrNull(edge.occurredAt),
    temporalStatus: redact(edge.temporalStatus) || 'unknown'
  }))
}

function cursorOf (page, digest) {
  return Buffer.from(JSON.stringify({ v: 1, page, digest })).toString('base64url')
}

function responseBytes (value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function loopbackOriginAllowed (origin) {
  const value = text(origin)
  return value === '' || LOOPBACK_ORIGIN.test(value)
}

export function buildMemoryEventExport ({ store, query = new URLSearchParams() } = {}) {
  const limit = parseLimit(query)
  const cursor = decodeCursor(query.get('cursor'))
  const requestedPage = cursor?.page ?? parsePage(query)
  const first = sourceRows(store, query, requestedPage, limit)
  const digestQuery = { ...first.query }
  delete digestQuery.page
  const sourceDigest = digestOf({
    query: digestQuery,
    memoryRows: first.allMemoryRows,
    nodes: first.graph.nodes,
    edges: first.graph.edges
  })
  if (cursor && cursor.digest !== sourceDigest) throw errorOf('snapshot_drift', 409)

  const episodes = buildEpisodes(first.memories.rows)
  const entities = buildEntities(first.graph.nodes)
  const legacyEdges = buildLegacyEdges(first.graph.edges)
  const nextPage = requestedPage < Number(first.memories.pageCount || Math.ceil(
    Number(first.memories.total) / limit
  ) || 1) ? requestedPage + 1 : null
  const output = {
    schema: MEMORY_EVENT_EXPORT_SCHEMA,
    readOnly: true,
    queryOnly: true,
    snapshot: {
      token: sourceDigest,
      sourceDigest,
      consistent: false,
      snapshotAtomic: false,
      reason: 'store_read_methods_are_not_one_atomic_cross_table_snapshot'
    },
    page: {
      limit,
      next: nextPage === null ? null : cursorOf(nextPage, sourceDigest),
      hasMore: nextPage !== null
    },
    episodes,
    entities,
    facts: [],
    factEvidence: [],
    legacyEdges,
    episodeLinks: [],
    diagnostics: {
      coverage: {
        returnedEpisodes: episodes.length,
        totalEpisodes: Number(first.memories.total) || 0,
        returnedEntities: entities.length,
        returnedLegacyEdges: legacyEdges.length,
        factCount: 0,
        episodeLinkInference: 'disabled'
      },
      unknownTime: episodes.filter(row => row.occurredAt === null || row.recordedAt === null).length,
      unresolved: legacyEdges.length,
      episodeLinkInference: 'disabled',
      gaps: [
        'owner_unavailable_from_store_read_projection',
        'source_quote_unavailable',
        'source_session_unavailable',
        'speaker_unavailable',
        'entity_aliases_unavailable',
        'legacy_fact_evidence_unverified'
      ]
    }
  }
  if (responseBytes(output) > EXPORT_MAX_RESPONSE_BYTES) {
    throw errorOf('export_budget_exceeded', 413)
  }
  return output
}

export function exportErrorResponse (error) {
  const code = ['invalid_limit', 'invalid_query', 'invalid_cursor', 'snapshot_drift',
    'export_budget_exceeded', 'export_source_budget_exceeded', 'source_unavailable',
    'source_locked', 'source_corrupt', 'source_sql_failed', 'source_read_failed',
    'schema_incompatible'].includes(error?.code)
    ? error.code : 'export_failed'
  return { schema: MEMORY_EVENT_EXPORT_SCHEMA, readOnly: true, queryOnly: true, error: code }
}

export function exportErrorStatus (error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 500
}
