import { createHash } from 'node:crypto'
const AUTHORITY_PROTOCOL = 'echo-memory-authority/v1'
const EXTRACT_ENTRIES = ['memory_add', 'memory_retrieve', 'memory_search', 'memory_association', 'memory_extract']
const bindingMatches = (binding, authority) => !!binding && binding.protocol === AUTHORITY_PROTOCOL
  && authority?.protocol === AUTHORITY_PROTOCOL && binding.epoch === authority.epoch
  && binding.generation === authority.generation

const TABLES = Object.freeze({
  memory_extract_requests: [
    ['request_hash', 'TEXT', 1, 0], ['protocol', 'TEXT', 0, 1], ['epoch', 'TEXT', 0, 1],
    ['generation', 'INTEGER', 0, 1], ['source_identity', 'TEXT', 0, 1],
    ['payload_hash', 'TEXT', 0, 1], ['status', 'TEXT', 0, 1],
    ['created_at_ms', 'INTEGER', 0, 1], ['result_hash', 'TEXT', 0, 0]
  ],
  memory_extract_stage_receipts: [
    ['request_hash', 'TEXT', 1, 1], ['stage', 'TEXT', 2, 1], ['action_key', 'TEXT', 3, 1],
    ['payload_hash', 'TEXT', 0, 1], ['status', 'TEXT', 0, 1],
    ['result_json', 'TEXT', 0, 1], ['error_code', 'TEXT', 0, 0], ['applied_at_ms', 'INTEGER', 0, 1]
  ],
  memory_extract_ack_receipts: [
    ['request_hash', 'TEXT', 1, 0], ['result_hash', 'TEXT', 0, 1],
    ['status', 'TEXT', 0, 1], ['ack_json', 'TEXT', 0, 1],
    ['stage_summary_json', 'TEXT', 0, 1], ['applied_at_ms', 'INTEGER', 0, 1],
    ['stale_skipped', 'INTEGER', 0, 1]
  ]
})
const quote = value => '"' + value.replace(/"/gu, '""') + '"'
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const compact = value => JSON.stringify(value)

export function inspectMemoryExtractPrepared(db, { epoch = null } = {}) {
  try {
    for (const [name, columns] of Object.entries(TABLES)) {
      const actual = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all()
      if (actual.length !== columns.length || actual.some((row, i) => {
        const [column, type, pk, notnull] = columns[i]
        return row.hidden !== 0 || row.name !== column || row.type.toUpperCase() !== type
          || row.pk !== pk || row.notnull !== notnull || row.dflt_value !== null
      })) return { status: 'incompatible', reason: 'extract_schema_incompatible' }
      for (const [column, type] of columns) {
        if (type !== 'TEXT') continue
        const eq = db.prepare(`EXPLAIN SELECT ${quote(column)}=? FROM ${quote(name)} LIMIT 1`)
          .all('extract-probe').filter(row => row.opcode === 'Eq')
        if (eq.length !== 1 || eq[0].p4 !== 'BINARY-8') return { status: 'incompatible', reason: 'extract_schema_incompatible' }
      }
      const primary = columns.filter(column => column[2]).sort((a, b) => a[2] - b[2])
      const valid = db.prepare(`PRAGMA index_list(${quote(name)})`).all().some(index => {
        if (index.origin !== 'pk' || index.partial) return false
        const keys = db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all().filter(row => row.key === 1)
        return keys.length === primary.length && primary.every(([column], i) =>
          keys[i]?.name === column && keys[i]?.coll === 'BINARY')
      })
      if (!valid) return { status: 'incompatible', reason: 'extract_schema_incompatible' }
    }
    if (epoch !== null && db.prepare('SELECT 1 FROM memory_extract_requests WHERE epoch<>? LIMIT 1').get(epoch)) {
      return { status: 'incompatible', reason: 'extract_epoch_mismatch' }
    }
    return { status: 'ready', epoch, reason: null }
  } catch { return { status: 'unavailable', reason: 'extract_schema_unavailable' } }
}

export function applyExtractHostAck(db, requestHash, ack, appliedAtMs, expected = null) {
  if (!db?.isTransaction) throw Error('extract_transaction_required')
  if (typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(requestHash)
    || !Number.isSafeInteger(appliedAtMs) || appliedAtMs < 1
    || !ack || typeof ack !== 'object') throw Error('extract_ack_invalid')
  const request = db.prepare('SELECT * FROM memory_extract_requests WHERE request_hash=?').get(requestHash)
  if (!request) throw Error('extract_request_missing')
  const ackRow = db.prepare('SELECT result_hash,status,ack_json,stage_summary_json,stale_skipped,applied_at_ms FROM memory_extract_ack_receipts WHERE request_hash=?').get(requestHash)
  if (expected) {
    const authority = expected.authorityOf?.(db), version = ack.hostVersion, proof = expected.proof
    if (authority?.status !== 'active' || !bindingMatches(expected.binding, authority)
      || JSON.stringify(authority.entries) !== JSON.stringify(EXTRACT_ENTRIES)) throw Error('extract_authority_changed')
    if (request.protocol !== 'echo-memory-extract/v1' || request.epoch !== expected.binding.epoch
      || request.generation !== expected.binding.generation || request.source_identity !== proof.sourceIdentity
      || request.created_at_ms !== proof.occurredAtMs || request.payload_hash !== expected.payloadHash
      || !version || ['sessionId', 'turn', 'endSeq', 'occurredAtMs', 'sourceIdentity']
        .some(key => version[key] !== proof[key])) throw Error('extract_result_binding_invalid')
    if (!ackRow || ackRow.result_hash !== sha(ackRow.ack_json) || request.result_hash !== ackRow.result_hash
      || request.status !== ackRow.status) throw Error('extract_ack_conflict')
    if (compact(ack) !== compact(JSON.parse(ackRow.ack_json))) throw Error('extract_ack_conflict')
    ack = JSON.parse(ackRow.ack_json)
    if (ackRow.stale_skipped === 1) return { status: 'duplicate', staleSkipped: true, complete: true }
    const peers = db.prepare(`SELECT a.ack_json FROM memory_extract_ack_receipts a
      JOIN memory_extract_requests r USING(request_hash)
      WHERE a.request_hash<>? AND a.stale_skipped=0 AND a.status IN ('partial','unknown','committed')
      AND CASE WHEN json_valid(a.ack_json) THEN json_extract(a.ack_json,'$.hostVersion.sessionId') END=? LIMIT 2049`)
      .all(requestHash, version.sessionId)
    if (peers.length > 2048) throw Error('extract_version_budget')
    for (const row of peers) {
      const prior = JSON.parse(row.ack_json).hostVersion
      if (!prior || !['turn', 'endSeq', 'occurredAtMs'].every(key => Number.isSafeInteger(prior[key]) && prior[key] > 0)) {
        throw Error('extract_host_version_invalid')
      }
      if (prior.turn === version.turn && prior.endSeq === version.endSeq) throw Error('extract_host_version_conflict')
      if ((prior.turn === version.turn && prior.endSeq > version.endSeq)
        || (prior.turn > version.turn && prior.endSeq > version.endSeq)) {
        db.prepare('UPDATE memory_extract_ack_receipts SET stale_skipped=1 WHERE request_hash=?').run(requestHash)
        return { status: 'duplicate', staleSkipped: true, complete: true }
      }
      if ((prior.turn > version.turn && prior.endSeq <= version.endSeq)
        || (prior.turn < version.turn && prior.endSeq >= version.endSeq)) throw Error('extract_host_version_conflict')
    }
  }
  if (!ack.stageStatuses || typeof ack.stageStatuses !== 'object' || Array.isArray(ack.stageStatuses)) {
    throw Error('extract_ack_invalid')
  }
  const finalAck = { ...ack, stageStatuses: { ...ack.stageStatuses } }
  const stageRows = db.prepare(`SELECT stage,status FROM memory_extract_stage_receipts WHERE request_hash=?`).all(requestHash)
  const statuses = new Map()
  for (const name of ['body', 'graph', 'threads']) {
    const values = stageRows.filter(row => row.stage === name).map(row => row.status)
    statuses.set(name, !values.length ? 'pending' : values.includes('unknown') ? 'unknown'
      : values.includes('failed') ? 'failed' : values.every(value => value === 'committed') ? 'committed' : 'partial')
  }
  if (expected && [...statuses.values()].some(value => value !== 'committed')) {
    return { status: [...statuses.values()].includes('unknown') ? 'unknown' : 'partial',
      complete: false, ack, staleSkipped: false }
  }
  const stageSummary = Object.fromEntries(['body', 'graph', 'threads', 'js_ack']
    .map(stageName => {
      if (stageName === 'js_ack') return [stageName, 'committed']
      const persisted = statuses.get(stageName)
      return [stageName, persisted]
    }))
  finalAck.stageStatuses = stageSummary
  const stagePayload = compact({ ack: finalAck, host: 'js_ack' })
  const stageHash = sha(stagePayload)
  const currentStage = db.prepare(`SELECT payload_hash,status FROM memory_extract_stage_receipts
    WHERE request_hash=? AND stage='js_ack' AND action_key='host'`).get(requestHash)
  if (currentStage && currentStage.payload_hash !== stageHash) throw Error('extract_stage_conflict')
  if (!currentStage) {
    db.prepare(`INSERT INTO memory_extract_stage_receipts
      (request_hash,stage,action_key,payload_hash,status,result_json,error_code,applied_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run(requestHash, 'js_ack', 'host', stageHash,
      'committed', stagePayload, null, appliedAtMs)
  }
  const complete = ['body', 'graph', 'threads', 'js_ack'].every(stageName => stageSummary[stageName] === 'committed')
  const unknown = Object.values(stageSummary).some(status => status === 'unknown')
  const status = complete ? 'committed' : unknown ? 'unknown' : 'partial'
  const resultJson = compact(finalAck)
  const resultHash = sha(resultJson)
  const summaryJson = compact(stageSummary)
  const staleSkipped = Number(ackRow?.stale_skipped) === 1
  const priorStageCommitted = currentStage?.status === 'committed'
  if (priorStageCommitted && ackRow?.status === 'committed') {
    if (ackRow.result_hash !== resultHash || ackRow.ack_json !== resultJson
      || ackRow.stage_summary_json !== summaryJson) throw Error('extract_ack_conflict')
    return { status: 'duplicate', resultHash, complete: true, staleSkipped, ack: finalAck }
  }
  if (!['started', 'partial', 'unknown'].includes(ackRow?.status ?? request.status)
    || !['started', 'partial', 'unknown'].includes(request.status)) throw Error('extract_ack_conflict')
  const updatedAck = ackRow
    ? db.prepare(`UPDATE memory_extract_ack_receipts SET result_hash=?,status=?,ack_json=?,
      stage_summary_json=?,applied_at_ms=?,stale_skipped=? WHERE request_hash=? AND status=?`)
      .run(resultHash, status, resultJson, summaryJson, appliedAtMs, staleSkipped ? 1 : 0,
        requestHash, ackRow.status)
    : db.prepare(`INSERT INTO memory_extract_ack_receipts
      (request_hash,result_hash,status,ack_json,stage_summary_json,applied_at_ms,stale_skipped)
      VALUES (?,?,?,?,?,?,?)`)
      .run(requestHash, resultHash, status, resultJson, summaryJson, appliedAtMs, 0)
  const updatedRequest = db.prepare(`UPDATE memory_extract_requests SET status=?,result_hash=?
    WHERE request_hash=? AND status=?`).run(status, resultHash, requestHash, request.status)
  if (Number(updatedAck.changes) !== 1 || Number(updatedRequest.changes) !== 1) {
    throw Error('extract_ack_conflict')
  }
  return { status, resultHash, complete, staleSkipped, ack: finalAck }
}
