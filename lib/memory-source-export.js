import { backup as nativeBackup, DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, existsSync, lstatSync, openSync, readFileSync, statSync, unlinkSync
} from 'node:fs'
import { dirname, resolve } from 'node:path'

export const SOURCE_EXPORT_LIMITS = Object.freeze({
  maxDbBytes: 64 * 1024 * 1024,
  maxLogicalBytes: 32 * 1024 * 1024,
  // Whole-table receipt budget, independent of ranking and traversal limits.
  maxRows: 4096,
  maxSchemaObjects: 512,
  maxTables: 128,
  maxReaders: 2
})

export const SNAPSHOT_PROTOCOL = 'echo-memory-snapshot/v1'
export const SNAPSHOT_TABLES = Object.freeze([
  'episodic_memory',
  'memory_consolidation_graph_nodes',
  'memory_consolidation_memory_links',
  'memory_consolidation_traffic_links',
  'memory_consolidation_meta'
])

const FAMILY = Object.freeze(['', '-wal', '-shm', '-journal'])
const REASONS = new Set([
  'source_path_invalid', 'source_not_found', 'source_not_regular',
  'source_symlink', 'source_hardlink', 'export_path_invalid',
  'export_parent_unavailable', 'export_destination_exists',
  'export_source_same_identity', 'source_identity_changed',
  'export_identity_changed', 'source_budget_exceeded', 'export_budget_exceeded',
  'source_open_failed', 'backup_failed', 'backup_integrity_failed',
  'backup_schema_mismatch', 'backup_content_mismatch', 'backup_corrupt',
  'export_sidecar_invalid', 'export_reader_capacity', 'owner_binding_unavailable',
  'export_not_ready', 'export_validation_failed'
])

const fail = reason => {
  const error = Error(REASONS.has(reason) ? reason : 'export_validation_failed')
  error.code = error.message
  throw error
}
const quote = value => '"' + String(value).replace(/"/gu, '""') + '"'
const canonical = value => resolve(value).toLowerCase()
const sha = value => createHash('sha256').update(value).digest('hex')
const shaText = value => sha(Buffer.from(value, 'utf8'))
const safeText = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max
const safeDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
// Receipt cells are SQLite NULL/TEXT/INTEGER/REAL, not arbitrary JSON.
function encodeContentCell (value) {
  if (value === null) return null
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      fail('export_budget_exceeded')
    }
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('export_budget_exceeded')
    if (Number.isSafeInteger(value) && !Object.is(value, -0)) return value
    // Use exact bits for non-integers, large REALs and signed zero; no float text formatting.
    const bytes = Buffer.alloc(8)
    bytes.writeDoubleBE(value)
    return ['f64', bytes.toString('hex')]
  }
  if (typeof value === 'string') return value
  fail('export_budget_exceeded')
}

function publicSummary ({ kind = 'backup_export', tokenHash = null, atomic = false,
  status = 'no-go', reason = null, exportIdentity = null } = {}) {
  return Object.freeze({ kind, tokenHash, atomic, status, reason, exportIdentity })
}

function sourceBinding ({ ownerSummary, ownerScope, turn, turnTrace, attempt, attemptId } = {}) {
  const owner = ownerSummary ?? ownerScope
  const boundTurn = turn ?? turnTrace
  const boundAttempt = attempt ?? attemptId
  if (!owner || owner.status !== 'verified' || owner.binding !== 'captured'
    || owner.reason !== null || !safeDigest(owner.ownerHash) || !safeDigest(owner.sessionHash)
    || !safeText(boundTurn) || !safeText(boundAttempt)) return null
  return Object.freeze({
    ownerHash: owner.ownerHash,
    sessionHash: owner.sessionHash,
    turn: boundTurn,
    attempt: boundAttempt
  })
}

function familyState (path, { hash = true } = {}) {
  const out = {}
  for (const suffix of FAMILY) {
    const file = path + suffix
    try {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isFile()) fail('export_sidecar_invalid')
      if (!Number.isSafeInteger(stat.size) || stat.size > SOURCE_EXPORT_LIMITS.maxDbBytes) {
        fail('source_budget_exceeded')
      }
      out[suffix || 'main'] = {
        size: stat.size,
        nlink: Number(stat.nlink) || 0,
        hash: hash ? sha(readFileSync(file)) : null
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
  return out
}

function comparableFamily (family) {
  return Object.fromEntries(Object.entries(family).map(([key, value]) => [key, {
    size: value.size,
    nlink: value.nlink,
    // SQLite may update -shm coordination bytes when a reader opens/closes.
    hash: key === '-shm' ? null : value.hash
  }]))
}

function sourceIdentity (path) {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}`
}

function digestDatabase (db) {
  let logicalBytes = 0
  const append = (digest, fragment) => {
    logicalBytes += Buffer.byteLength(fragment, 'utf8')
    if (logicalBytes > SOURCE_EXPORT_LIMITS.maxLogicalBytes) fail('export_budget_exceeded')
    digest.update(fragment, 'utf8')
  }
  const schema = createHash('sha256')
  append(schema, '[')
  let schemaCount = 0
  const availableTables = new Set()
  for (const { name, sql, type } of db.prepare(
    "SELECT type,name,sql FROM sqlite_master " +
    "WHERE type IN ('table','index','trigger','view') ORDER BY type,name LIMIT ?"
  ).iterate(SOURCE_EXPORT_LIMITS.maxSchemaObjects + 1)) {
    if (++schemaCount > SOURCE_EXPORT_LIMITS.maxSchemaObjects) fail('source_budget_exceeded')
    if (type === 'table') availableTables.add(name)
    if (schemaCount > 1) append(schema, ',')
    append(schema, JSON.stringify({ name, sql, type }))
  }
  append(schema, ']')
  const schemaHash = schema.digest('hex')
  if (SNAPSHOT_TABLES.some(table => !availableTables.has(table))) fail('backup_schema_mismatch')
  const content = createHash('sha256')
  append(content, '[')
  let rowCount = 0
  let separator = ''
  for (const table of SNAPSHOT_TABLES) {
    const statement = db.prepare(
      `SELECT * FROM ${quote(table)} ORDER BY rowid LIMIT ?`
    )
    // Keep SQLite INTEGERs exact until the safe range has been checked.
    statement.setReadBigInts(true)
    append(content, `${separator}[${JSON.stringify(table)},[`)
    let count = 0
    for (const row of statement.iterate(SOURCE_EXPORT_LIMITS.maxRows + 1)) {
      if (++count > SOURCE_EXPORT_LIMITS.maxRows) fail('export_budget_exceeded')
      if (count > 1) append(content, ',')
      // Preserve the same canonical table/row framing; check bytes before retaining another row.
      append(content, JSON.stringify(Object.keys(row).sort()
        .map(key => [key, encodeContentCell(row[key])])))
    }
    rowCount += count
    append(content, ']]')
    separator = ','
  }
  append(content, ']')
  return {
    schemaHash,
    contentHash: content.digest('hex'),
    rowCount,
    tableCount: SNAPSHOT_TABLES.length,
    logicalBytes
  }
}

function integrityOk (db) {
  const row = db.prepare('PRAGMA integrity_check(1)').get()
  return row?.integrity_check === 'ok'
}

function configureReader (db) {
  db.exec('PRAGMA query_only=ON')
  db.exec('BEGIN')
  return db
}

function targetIdentityCheck (path, expectedIdentity) {
  if (!existsSync(path)) fail('export_identity_changed')
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || Number(stat.nlink) !== 1
    || sourceIdentity(path) !== expectedIdentity) fail('export_identity_changed')
  if (stat.size > SOURCE_EXPORT_LIMITS.maxDbBytes) fail('export_budget_exceeded')
}

function clearExportSidecars (path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = path + suffix
    try {
      const stat = lstatSync(sidecar)
      if (stat.isSymbolicLink() || !stat.isFile() || Number(stat.nlink) !== 1) {
        fail('export_sidecar_invalid')
      }
      unlinkSync(sidecar)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function exposeCapability ({
  summary, exportPath, exportIdentity, expectedDigest, openDatabase, privateManifest
}) {
  let activeReaders = 0
  const openReader = () => {
    if (activeReaders >= SOURCE_EXPORT_LIMITS.maxReaders) {
      return { status: 'no-go', reason: 'export_reader_capacity' }
    }
    let db = null
    try {
      targetIdentityCheck(exportPath, exportIdentity)
      db = configureReader(openDatabase(exportPath, { readOnly: true }))
      if (!integrityOk(db)) fail('backup_corrupt')
      const digest = digestDatabase(db)
      if (digest.schemaHash !== expectedDigest.schemaHash
        || digest.contentHash !== expectedDigest.contentHash) fail('backup_content_mismatch')
      activeReaders += 1
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        try { if (db.isTransaction) db.exec('ROLLBACK') } catch {}
        try { db.close() } catch {}
        activeReaders -= 1
      }
      return {
        status: 'ready',
        reason: null,
        reader: Object.freeze({ db, close })
      }
    } catch (error) {
      try { if (db?.isTransaction) db.exec('ROLLBACK') } catch {}
      try { db?.close() } catch {}
      return {
        status: 'no-go',
        reason: REASONS.has(error?.code) ? error.code : 'export_validation_failed'
      }
    }
  }
  const capability = {
    openReader,
    validate: () => {
      const first = openReader()
      if (first.status !== 'ready') return first
      first.reader.close()
      return { status: 'ready', reason: null }
    }
  }
  Object.defineProperty(capability, 'token', { value: randomBytes(32), enumerable: false })
  Object.defineProperty(capability, 'manifest', {
    value: () => structuredClone(privateManifest),
    enumerable: false
  })
  const result = { ...summary }
  Object.defineProperty(result, 'capability', { value: Object.freeze(capability), enumerable: false })
  return Object.freeze(result)
}

export async function createImmutableSourceExport (options = {}, dependencies = {}) {
  const {
    sourcePath, exportPath, ownerSummary, ownerScope, turn, turnTrace, attempt, attemptId
  } = options
  const failResult = reason => publicSummary({ reason })
  const binding = sourceBinding({ ownerSummary, ownerScope, turn, turnTrace, attempt, attemptId })
  if (!binding) return failResult('owner_binding_unavailable')
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return failResult('source_path_invalid')
  if (typeof exportPath !== 'string' || !exportPath.trim()) return failResult('export_path_invalid')
  const source = resolve(sourcePath), destination = resolve(exportPath)
  const openDatabase = dependencies.openDatabase ?? ((path, opts) => new DatabaseSync(path, opts))
  let sourceDb = null
  let targetDb = null
  let reserved = false
  try {
    if (!existsSync(source)) return failResult('source_not_found')
    const sourceStat = lstatSync(source)
    if (sourceStat.isSymbolicLink()) return failResult('source_symlink')
    if (!sourceStat.isFile() || Number(sourceStat.nlink) !== 1) return failResult('source_not_regular')
    if (!existsSync(dirname(destination))) return failResult('export_parent_unavailable')
    if (canonical(source) === canonical(destination)) return failResult('export_source_same_identity')
    for (const suffix of FAMILY) {
      if (existsSync(destination + suffix) || (() => { try { lstatSync(destination + suffix); return true } catch { return false } })()) {
        return failResult('export_destination_exists')
      }
    }
    const sourceId = sourceIdentity(source)
    const sourceFamilyBefore = familyState(source)
    sourceDb = openDatabase(source, { readOnly: true })
    configureReader(sourceDb)
    if (!integrityOk(sourceDb)) fail('backup_integrity_failed')
    const before = digestDatabase(sourceDb)
    const fd = openSync(destination, 'wx', 0o600)
    closeSync(fd)
    reserved = true
    const doBackup = dependencies.backupDatabase ?? nativeBackup
    await doBackup(sourceDb, destination)
    targetIdentityCheck(destination, sourceIdentity(destination))
    targetDb = configureReader(openDatabase(destination, { readOnly: true }))
    if (!integrityOk(targetDb)) fail('backup_integrity_failed')
    const after = digestDatabase(targetDb)
    if (after.schemaHash !== before.schemaHash) fail('backup_schema_mismatch')
    if (after.contentHash !== before.contentHash) fail('backup_content_mismatch')
    targetDb.exec('ROLLBACK')
    targetDb.close()
    targetDb = null
    clearExportSidecars(destination)
    const sourceFamilyAfter = familyState(source)
    if (sourceId !== sourceIdentity(source)
      || JSON.stringify(comparableFamily(sourceFamilyBefore))
        !== JSON.stringify(comparableFamily(sourceFamilyAfter))) fail('source_identity_changed')
    const targetId = sourceIdentity(destination)
    const tokenHash = sha(readFileSync(destination))
    const exportIdentity = shaText(JSON.stringify({ targetId, ...after }))
    const handle = 'snapshot_' + randomBytes(24).toString('hex')
    const receipt = Object.freeze({
      protocol: SNAPSHOT_PROTOCOL,
      kind: 'backup_export',
      tokenHash,
      schemaHash: before.schemaHash,
      contentHash: before.contentHash,
      ownerHash: binding.ownerHash,
      turnHash: shaText(binding.turn),
      attemptHash: shaText(binding.attempt)
    })
    const summary = publicSummary({
      kind: 'backup_export',
      tokenHash,
      atomic: true,
      status: 'ready',
      reason: null,
      exportIdentity
    })
    const result = exposeCapability({
      summary,
      exportPath: destination,
      exportIdentity: targetId,
      expectedDigest: before,
      openDatabase,
      privateManifest: {
        protocol: SNAPSHOT_PROTOCOL,
        kind: 'backup_export',
        handle,
        path: destination,
        receipt,
        limits: { rows: SOURCE_EXPORT_LIMITS.maxRows, tables: [...SNAPSHOT_TABLES] }
      }
    })
    return result
  } catch (error) {
    const reason = REASONS.has(error?.code) ? error.code
      : error?.code === 'SQLITE_BUSY' ? 'backup_failed' : 'backup_failed'
    return failResult(reason)
  } finally {
    for (const db of [targetDb, sourceDb]) {
      try { if (db?.isTransaction) db.exec('ROLLBACK') } catch {}
      try { db?.close() } catch {}
    }
    // The reserved destination belongs to this isolated attempt. It is never
    // removed on failure: a caller can inspect the failed evidence safely.
    void reserved
  }
}
