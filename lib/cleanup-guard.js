/**
 * dsh-echo — 记忆归档守卫 + 批次回滚(纯逻辑,可单测)
 * ============================================================
 * 2026-09-27 F7 现场(他自查审计发现的):
 *
 * `scripts/memory-doctor.mjs --clean --yes` 是那 27 条 `memory_cleanup` 的
 * **生产者**。它把 `rejectReason` 判成 `self-referential` / `host-injection`
 * 的**现役**记忆一律归档,而那条判据本是**写入侧**的闸:
 *
 *   写入侧:宁可漏拒(少记一条工作话),不许错拒(把他的生活当工程噪音扔掉)。
 *   归档侧:同一个判据被**追溯**施加,代价完全不同 —— 写入侧的"漏拒"只是多记
 *           一条,归档侧的"错拒"是**把他已经记住的东西删掉**。
 *
 * 实测被归档的是他**当前正在做的项目整簇**:
 *   AI 记忆架构 #10 #36 #37 #40 #43 #100 #109 #144 #156
 *   多人 agent   #46 #50 #51 #113 #157
 *   面试/预算     #77 #119 #173
 *   审查台与图谱  #238 #240 #241 #243 #244 #246 #247 **#248** #250
 * 其中 **#248 就是他让我「去开源社区与学术论文里找现成图谱实现作参照」的那条请求**。
 * 图侧同步受害:12/35 条边 `is_active=0`,含整个「Echo记忆架构」簇。
 *
 * 所以归档侧要有**自己的**守卫(比写入侧严得多),并且**可回滚**。
 */

// ═══════════════════════════════════════════════════════════════════════
// 守卫规则
// ═══════════════════════════════════════════════════════════════════════

/** 内在价值 ≥ 此值 ⇒ 不许归档(它是 Judge 给的"这条对他有多重要")。 */
export const PROTECT_IV = 50

/**
 * 情感分 ≥ 此值 ⇒ 不许归档。
 * 与 `python/engine/episodic.py:cleanup_stale` 的 TTL 豁免**同一条规则**
 * ("情感分是内在价值")—— 归档侧不许比 TTL 侧还狠。
 */
export const PROTECT_EMOTION = 6

/** 近 N 天内的记忆 ⇒ 不许归档。"当前项目"永远落在窗口里。 */
export const PROTECT_DAYS = 7

/**
 * 这条记忆该不该被归档流程**豁免**?
 *
 * @param {{id:number, layer?:string, intrinsicValue?:number, emotionScore?:number, timestamp?:number}} row
 * @param {number} now epoch 秒
 * @returns {{protected:boolean, why:string}}
 */
export function cleanupProtected (row, now) {
  if (row === null || typeof row !== 'object') return { protected: false, why: '' }
  const nowVal = Number(now) || 0
  // L0 = 身份/称呼/长期关系。按"工程自指"这种**文本判据**去归档身份事实,
  // 是最不该发生的一类误伤(L0 是每轮强制注入的)。
  if (String(row.layer || '') === 'L0') return { protected: true, why: 'core-tier' }
  if (Number(row.intrinsicValue || 0) >= PROTECT_IV) {
    return { protected: true, why: 'high-value(I≥' + PROTECT_IV + ')' }
  }
  if (Number(row.emotionScore || 0) >= PROTECT_EMOTION) {
    return { protected: true, why: 'high-emotion(情感≥' + PROTECT_EMOTION + ')' }
  }
  const ts = Number(row.timestamp || 0)
  if (nowVal > 0 && ts > 0 && nowVal - ts < PROTECT_DAYS * 86400) {
    return { protected: true, why: 'recent(<' + PROTECT_DAYS + '天)' }
  }
  return { protected: false, why: '' }
}

/**
 * 把候选行分成「该归档」与「被守卫拦下」两堆。
 *
 * @param {Array<object>} rows
 * @param {number} now epoch 秒
 */
export function planCleanup (rows, now) {
  const targets = []
  const kept = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r === null || typeof r !== 'object') continue
    if (Number(r.active ?? r.isActive ?? 0) !== 1) continue   // 只动现役
    const v = cleanupProtected(r, now)
    if (v.protected) kept.push({ ...r, why: v.why })
    else targets.push(r)
  }
  return { targets, kept }
}

// ═══════════════════════════════════════════════════════════════════════
// 批次归档 / 一键回滚
// ═══════════════════════════════════════════════════════════════════════

/** 批次在 `audit_logs.trace_id` 里的前缀。trace_id 是主键,查得准。 */
export function batchTracePrefix (batchId) {
  return 'cleanup:' + String(batchId) + ':'
}

/** 造一个批次 id(秒级时间戳 + 随机后缀,防同一秒跑两次撞车)。 */
export function newBatchId (now) {
  const t = Math.floor(Number(now) || Date.now() / 1000)
  const r = Math.floor(Math.random() * 1e6).toString(36).padStart(4, '0')
  return t + '-' + r
}

/**
 * 按批次归档一批记忆:`is_active=0` + 审计留痕(trace_id 带批次前缀)。
 * 行**不删**,面板翻得出来。
 *
 * @returns {{archived:number, failed:number, batchId:string}}
 */
export function archiveBatch (db, batchId, rows, now) {
  const prefix = batchTracePrefix(batchId)
  const nowVal = Number(now) || Date.now() / 1000
  let archived = 0
  let failed = 0
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = Number(r?.id ?? r?.memoryId ?? 0)
    if (!id) continue
    try {
      db.prepare('UPDATE episodic_memory SET is_active = 0 WHERE memory_id = ?').run(id)
      db.prepare(
        'INSERT OR REPLACE INTO audit_logs (trace_id, session_id, user_key, user_input,' +
        ' tool_call, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(prefix + id, 'global', 'master',
        '批次 ' + String(batchId) + ' 归档脏记忆 #' + id + ':' + String(r.summary || '').slice(0, 80),
        'memory_cleanup', nowVal)
      archived += 1
    } catch { failed += 1 }
  }
  return { archived, failed, batchId: String(batchId) }
}

/**
 * 一键回滚一个批次:把该批次归档过的记忆恢复成现役,并留一条回滚审计。
 *
 * ⚠️ 诚实说明:批次索引存在 `audit_logs` 里,而 `store.writeAudit` 会把审计
 * 裁到最近 100 条(`lib/store.js:769-782`,活库实测恰 100 行)。所以**太久
 * 之后回滚会找不到索引** —— 要撤销就当轮撤销。这是无 DDL 变更下的取舍:
 * 加一张批次表能永久留索引,但那要动两边 DDL(有 parity 守卫),不值当。
 *
 * @returns {{restored:number, notFound:boolean, ids:number[]}}
 */
export function rollbackBatch (db, batchId, now) {
  const prefix = batchTracePrefix(batchId)
  const nowVal = Number(now) || Date.now() / 1000
  let rows = []
  try {
    rows = db.prepare(
      "SELECT trace_id FROM audit_logs WHERE tool_call = 'memory_cleanup'" +
      ' AND trace_id LIKE ?'
    ).all(prefix + '%')
  } catch { rows = [] }
  if (rows.length === 0) return { restored: 0, notFound: true, ids: [] }
  const ids = []
  for (const r of rows) {
    const tail = String(r.trace_id || '').slice(prefix.length)
    const id = Number(tail)
    if (Number.isInteger(id) && id > 0) ids.push(id)
  }
  let restored = 0
  for (const id of ids) {
    try {
      db.prepare('UPDATE episodic_memory SET is_active = 1 WHERE memory_id = ?').run(id)
      restored += 1
    } catch { /* 单条失败不回滚整批 */ }
  }
  try {
    db.prepare(
      'INSERT OR REPLACE INTO audit_logs (trace_id, session_id, user_key, user_input,' +
      ' tool_call, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('cleanup-rollback:' + String(batchId), 'global', 'master',
      '回滚批次 ' + String(batchId) + ':恢复 ' + restored + ' 条记忆',
      'memory_restore', nowVal)
  } catch { /* 审计写不进去也不该让恢复作废 */ }
  return { restored, notFound: false, ids }
}
