import { DatabaseSync, backup } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { realpathSync, lstatSync, statSync, existsSync, openSync, closeSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { inspectP3Preparation, applyP3PreparationInTransaction } from './memory-association-prepared.js'

export const P3_PREPARE_LIMITS = Object.freeze({
  dbBytes: 64 * 1024 * 1024, logicalBytes: 128 * 1024 * 1024, rows: 100000, tables: 128, schemaObjects: 512
})
const error = reason => { throw Error(reason) }
const quote = value => '"' + value.replace(/"/gu, '""') + '"'
const canonical = path => resolve(path).toLowerCase()
const identity = path => { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}` }
const familySuffixes = ['', '-wal', '-shm', '-journal']
function backupFamilyClear(destination, reserved = null) {
  for (const suffix of familySuffixes) {
    let entry
    try { entry = lstatSync(destination + suffix) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    if (suffix) error('backup_family_exists')
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) error('unsafe_backup_path')
    if (!reserved) error('backup_exists')
    if (identity(destination) !== reserved) error('backup_identity_changed')
  }
}
export const encodeP3Value = value => JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isFinite(item)
  ? ['nonfinite', Number.isNaN(item) ? 'nan' : item > 0 ? '+infinity' : '-infinity']
  : typeof item === 'bigint' ? ['integer', String(item)]
  : ArrayBuffer.isView(item) ? ['blob', Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('base64')] : item)

/** Bounded logical verification, not a byte-copy comparison of SQLite journal headers. */
export function digestP3Database(db) {
  const pageBytes = Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size)
  if (pageBytes > P3_PREPARE_LIMITS.dbBytes) error('prepare_budget_exceeded')
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT ?").all(P3_PREPARE_LIMITS.schemaObjects + 1)
  const tables = schema.filter(row => row.type === 'table')
  if (schema.length > P3_PREPARE_LIMITS.schemaObjects || tables.length > P3_PREPARE_LIMITS.tables) error('prepare_budget_exceeded')
  let rows = 0, logicalBytes = 0
  const hash = createHash('sha256'), schemaHash = createHash('sha256'), tableHashes = new Map()
  const feed = (target, value) => {
    const text = encodeP3Value(value)
    logicalBytes += Buffer.byteLength(text)
    if (logicalBytes > P3_PREPARE_LIMITS.logicalBytes) error('prepare_budget_exceeded')
    target.update(text + '\n')
    hash.update(text + '\n')
  }
  for (const row of schema) feed(schemaHash, row)
  for (const table of tables) {
    const tableHash = createHash('sha256')
    const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all()
    const pk = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk)
    const names = new Set(columns.map(column => column.name.toLowerCase()))
    const withoutRowid = db.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name=? LIMIT 1").get(table.name)?.wr === 1
    const rowid = ['_rowid_', 'rowid', 'oid'].find(name => !names.has(name))
    if (!withoutRowid && !rowid) error('prepare_digest_unsupported')
    let alias = '__p3_row_identity'
    while (names.has(alias)) alias += '_'
    const order = pk.length ? pk.map(column => quote(column.name)).join(',') : rowid
    const identityColumn = withoutRowid ? '' : `${rowid} AS ${quote(alias)},`
    const stmt = db.prepare(`SELECT ${identityColumn}* FROM ${quote(table.name)} ORDER BY ${order} LIMIT ?`)
    stmt.setReadBigInts(true)
    for (const row of stmt.iterate(P3_PREPARE_LIMITS.rows + 1)) {
      if (++rows > P3_PREPARE_LIMITS.rows) error('prepare_budget_exceeded')
      feed(tableHash, [table.name, row])
    }
    tableHashes.set(table.name, tableHash.digest('hex'))
  }
  return { hash: hash.digest('hex'), schemaHash: schemaHash.digest('hex'), tableCount: tables.length, rowCount: rows,
    logicalBytes, pageBytes, tableHashes }
}

function paths(dbPath, backupPath, apply) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) error('db_path_required')
  const requested = resolve(dbPath)
  if (!existsSync(requested) || !lstatSync(requested).isFile() || lstatSync(requested).isSymbolicLink()) error('unsafe_source_path')
  const source = realpathSync(requested)
  const sourceIdentity = identity(source)
  const protectedPaths = [source, source + '-wal', source + '-shm', source + '-journal']
  const size = protectedPaths.filter(existsSync).reduce((sum, path) => sum + statSync(path).size, 0)
  if (!apply) {
    if (statSync(source).nlink > 1) error('unsafe_source_alias')
    if (size > P3_PREPARE_LIMITS.dbBytes) error('prepare_budget_exceeded')
    return { source, sourceIdentity }
  }
  if (typeof backupPath !== 'string' || !backupPath.trim()) error('backup_path_required')
  const destination = join(realpathSync(dirname(resolve(backupPath))), basename(backupPath))
  if (protectedPaths.some(path => canonical(path) === canonical(destination))) error('unsafe_backup_path')
  // Check the complete destination family before any SQLite open; never clean stale artifacts.
  backupFamilyClear(destination)
  if (statSync(source).nlink > 1) error('unsafe_source_alias')
  if (size > P3_PREPARE_LIMITS.dbBytes) error('prepare_budget_exceeded')
  return { source, destination, sourceIdentity }
}
const publicDigest = d => ({ hash: d.hash, schemaHash: d.schemaHash, tableCount: d.tableCount, rowCount: d.rowCount })
const known = new Set(['db_path_required', 'unsafe_source_path', 'unsafe_source_alias', 'backup_path_required', 'unsafe_backup_path',
  'backup_exists', 'backup_family_exists', 'prepare_budget_exceeded', 'source_schema_incompatible', 'prepared_schema_incompatible',
  'source_changed_since_backup', 'backup_verification_failed', 'source_identity_changed', 'backup_identity_changed', 'prepare_digest_unsupported'])

export async function prepareAssociationUse({ dbPath, backupPath, apply = false } = {}, { backupDatabase = backup, openDatabase = (...args) => new DatabaseSync(...args) } = {}) {
  const report = { status: 'failed', reason: null, phase: 'paths', backupCreated: false, backupVerified: false, applied: false }
  let source, destination, writer
  try {
    const p = paths(dbPath, backupPath, apply === true)
    source = openDatabase(p.source, { readOnly: true })
    if (identity(p.source) !== p.sourceIdentity || lstatSync(p.source).isSymbolicLink() || statSync(p.source).nlink !== 1) error('source_identity_changed')
    source.exec('PRAGMA query_only=ON')
    report.phase = 'preview'
    const preview = inspectP3Preparation(source)
    report.preview = preview
    if (apply !== true || !['ready', 'needs_prepare'].includes(preview.status)) {
      return { ...report, status: preview.status, reason: preview.reason }
    }
    report.phase = 'backup'
    source.exec('BEGIN')
    const before = digestP3Database(source)
    report.before = publicDigest(before)
    const fd = openSync(p.destination, 'wx', 0o600)
    closeSync(fd)
    report.backupCreated = true
    const reserved = identity(p.destination)
    backupFamilyClear(p.destination, reserved)
    await backupDatabase(source, p.destination)
    if (identity(p.destination) !== reserved || lstatSync(p.destination).isSymbolicLink() || statSync(p.destination).nlink !== 1) error('backup_identity_changed')
    destination = openDatabase(p.destination, { readOnly: true })
    destination.exec('PRAGMA query_only=ON')
    destination.exec('BEGIN')
    if (destination.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') error('backup_verification_failed')
    const recovered = digestP3Database(destination)
    if (before.hash !== recovered.hash || before.schemaHash !== recovered.schemaHash) error('backup_verification_failed')
    report.backupVerified = true
    destination.exec('ROLLBACK'); destination.close(); destination = null
    source.exec('ROLLBACK'); source.close(); source = null
    report.phase = 'apply'
    if (identity(p.source) !== p.sourceIdentity) error('source_identity_changed')
    writer = openDatabase(p.source)
    if (identity(p.source) !== p.sourceIdentity || lstatSync(p.source).isSymbolicLink() || statSync(p.source).nlink !== 1) error('source_identity_changed')
    writer.exec('PRAGMA busy_timeout=0')
    writer.exec('BEGIN IMMEDIATE')
    const locked = digestP3Database(writer)
    if (locked.hash !== before.hash) error('source_changed_since_backup')
    applyP3PreparationInTransaction(writer)
    const after = digestP3Database(writer)
    for (const [table, hash] of before.tableHashes) if (after.tableHashes.get(table) !== hash) error('source_changed_since_backup')
    report.after = publicDigest(after)
    writer.exec('COMMIT')
    report.applied = true
    return { ...report, status: 'prepared', reason: null, phase: 'complete' }
  } catch (e) {
    if (writer?.isTransaction) { try { writer.exec('ROLLBACK') } catch {} }
    report.reason = known.has(e?.message) ? e.message : e?.errcode === 5 ? 'prepare_busy'
      : report.phase === 'backup' ? 'backup_failed' : report.phase === 'apply' ? 'prepare_apply_failed' : 'prepare_failed'
    return report
  } finally {
    for (const db of [destination, source, writer]) {
      if (!db) continue
      try { if (db.isTransaction) db.exec('ROLLBACK') } catch {}
      try { db.close() } catch {}
    }
  }
}
