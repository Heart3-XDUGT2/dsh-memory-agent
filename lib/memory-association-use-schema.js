const base = {
  memory_association_use_receipts: {
    columns: [['round_id', 'TEXT', 1, 0], ['payload_hash', 'TEXT', 0, 1], ['evidence_status', 'TEXT', 0, 1],
      ['channel', 'TEXT', 0, 1], ['used_at_ms', 'REAL', 0, 1], ['memory_count', 'INTEGER', 0, 1], ['unit_count', 'INTEGER', 0, 1]],
    sql: 'round_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,evidence_status TEXT NOT NULL,channel TEXT NOT NULL,used_at_ms REAL NOT NULL,memory_count INTEGER NOT NULL,unit_count INTEGER NOT NULL'
  },
  memory_association_use_events: {
    columns: [['round_id', 'TEXT', 1, 1], ['unit_kind', 'TEXT', 2, 1], ['unit_id', 'TEXT', 3, 1]],
    sql: 'round_id TEXT NOT NULL,unit_kind TEXT NOT NULL,unit_id TEXT NOT NULL,PRIMARY KEY(round_id,unit_kind,unit_id)'
  },
  memory_association_use_state: {
    columns: [['unit_kind', 'TEXT', 1, 1], ['unit_id', 'TEXT', 2, 1], ['use_count', 'INTEGER', 0, 1],
      ['last_used_ms', 'REAL', 0, 1], ['half_life_hours', 'REAL', 0, 0]],
    sql: 'unit_kind TEXT NOT NULL,unit_id TEXT NOT NULL,use_count INTEGER NOT NULL,last_used_ms REAL NOT NULL,half_life_hours REAL,PRIMARY KEY(unit_kind,unit_id)'
  },
  memory_association_use_failures: {
    columns: [['failure_id', 'INTEGER', 1, 0], ['round_id', 'TEXT', 0, 0], ['reason', 'TEXT', 0, 1], ['failed_at_ms', 'REAL', 0, 1]],
    sql: 'failure_id INTEGER PRIMARY KEY,round_id TEXT,reason TEXT NOT NULL,failed_at_ms REAL NOT NULL'
  }
}
const traffic = {
  memory_association_traffic_strength: {
    columns: [['link_id', 'TEXT', 1, 0], ['intrinsic_value', 'REAL', 0, 1], ['weight', 'REAL', 0, 1],
      ['model_started_ms', 'REAL', 0, 1], ['initialization', 'TEXT', 0, 1]],
    sql: 'link_id TEXT PRIMARY KEY,intrinsic_value REAL NOT NULL,weight REAL NOT NULL,model_started_ms REAL NOT NULL,initialization TEXT NOT NULL'
  }
}
export const associationUseDefinitions = (trafficDynamics = false) => ({ ...base, ...(trafficDynamics ? traffic : {}) })
export function inspectAssociationUseSchema(db, { trafficDynamics = false, strict = false } = {}) {
  let missing = 0, invalid = 0
  for (const [name, definition] of Object.entries(associationUseDefinitions(trafficDynamics))) {
    const rows = db.prepare(`PRAGMA ${strict ? 'table_xinfo' : 'table_info'}("${name}")`).all()
    if (!rows.length) { missing++; continue }
    if (strict && rows.some(row => row.hidden !== 0)) { invalid++; continue }
    const primary = definition.columns.filter(column => column[2]).sort((a, b) => a[2] - b[2])
    const indexes = db.prepare(`PRAGMA index_list("${name}")`).all()
    const rowidKey = primary.length === 1 && primary[0][1] === 'INTEGER'
    const hasIndependentPrimary = indexes.some(index => index.origin === 'pk')
    const binaryPrimary = rowidKey
      ? (!strict || !hasIndependentPrimary)
      : indexes.some(index => {
      if (index.origin !== 'pk' || index.partial) return false
      const keys = db.prepare(`PRAGMA index_xinfo("${index.name.replace(/"/gu, '""')}")`).all().filter(row => row.key === 1)
      return keys.length === primary.length && primary.every(([column], i) =>
        keys[i]?.name === column && keys[i]?.coll?.toUpperCase() === 'BINARY')
      })
    const identities = definition.columns.filter(([column]) => ['round_id', 'unit_kind', 'unit_id', 'link_id'].includes(column))
    const binaryComparison = identities.every(([column]) => {
      if (!rows.some(row => row.name === column)) return false
      // Native bytecode exposes the effective column comparison, independent of PK index overrides.
      const plan = db.prepare(`EXPLAIN SELECT "${column}"=? FROM "${name}" LIMIT 1`).all('p3-collation-probe')
      const comparisons = plan.filter(row => row.opcode === 'Eq')
      return plan.length <= 128 && comparisons.length === 1 && comparisons[0].p4 === 'BINARY-8'
    })
    if (!binaryPrimary || !binaryComparison || rows.length !== definition.columns.length || definition.columns.some(([column, type, pk, notnull]) => {
      const row = rows.find(value => value.name === column)
      return !row || row.type.toUpperCase() !== type || row.pk !== pk || row.notnull !== notnull || row.dflt_value !== null
    })) invalid++
  }
  return { missing, invalid }
}
export function assertAssociationUseSchema(db, options = {}) {
  const result = inspectAssociationUseSchema(db, options)
  if (result.missing || result.invalid) throw Error(options.trafficDynamics ? 'traffic_schema_incompatible' : 'p3_schema_incompatible')
}
/** Trusted prepare/bootstrap caller owns the transaction; this helper never commits. */
export function createAssociationUseTablesInTransaction(db, { trafficDynamics = false } = {}) {
  if (!db?.isTransaction) throw Error('schema_transaction_required')
  for (const [name, definition] of Object.entries(associationUseDefinitions(trafficDynamics))) {
    db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${definition.sql})`)
  }
  assertAssociationUseSchema(db, { trafficDynamics })
}
