/**
 * 语音回执账(voice_receipts)—— heart-tts 的 `voice.external` / `voice.interrupted` 落账。
 *
 * 背景:heart-tts v1.2.0(主对话 DSH+TTS 的语音输出)按契约软发现
 * `ctx.get('echo:relay')` 上的 `registerVoiceReceipt(entry)`,把两条回执推过来:
 *   - voice.external     某句跨过**可撤边界**(交给合成引擎、服务端确认开始合成),
 *                        重复 /speak 不重发;主包按 (session, seq) 对账;
 *   - voice.interrupted  **打断痕**(整轮一条):lastExternalSeq(打断点)、
 *                        externalSeqs(本轮已外化)、droppedSeqs(已切出未外化、
 *                        干净撤回的句子)、reason。
 *
 * 用途(2026-10-04 修正版决策 4):**主对话的打断留痕 / 情绪余波 / 状态记录**,
 * **不是**与 QQ 对账。turnId 是 heart-tts 宿主自造的 `<sessionId>#t<N>`(不是共享
 * 轮次 id),只作参考;对账键是 (session, seq)。
 * 契约形状以队友仓 `docs/voice-receipts.md` §2 为准,一字不改。
 *
 * 纪律(每条都有具体理由):
 *   - **绝不抛错**:钩子一抛错,heart-tts 会把接收端当契约违约弃用(它的容错纪律),
 *     于是回执静默断流。所以 receive() 全量兜底,坏输入只记日志、丢弃;
 *   - **独立成文件**:不进 lib/relay.js 的出站/入站流程(红线文件一行不动),
 *     与其他模块解耦 —— 将来换落账形态只改这一个文件(见文件尾注);
 *   - **只建不拆**:建表只用 CREATE TABLE IF NOT EXISTS,没有 DROP/重建迁移
 *     (回执表的既定规矩,见 tests/graph-gate.test.js 那条纪律);
 *   - **每会话 500 条滚动上限**:超限删最旧,账不能无限长。
 *
 * ===== 将来想改落账形态,改动面就在这一个文件 =====
 *   持久化只发生在本文件的 insert/queries 两处(SQL 就这几条);
 *   对外只暴露 createVoiceReceiptLedger() 返回的那几个方法。
 *   换形态(比如挪进 relay 账旁、或改 JSONL):换掉本文件的落账实现即可,
 *   index.js 的一行桥接与 heart-tts 侧零改动。
 */
/** 每会话回执保留上限:超限按 (at, id) 删最旧。 */
export const PER_SESSION_CAP = 500

/**
 * echo_status 状态面的形状真值(给 `scripts/check_tools.mjs` 的离线闸用):
 * 「同批加键同批声明」的对拍夹具 —— 必须带一份**非空**形状(两条 recent、
 * 可空字段 seq/reason 各有"有值"与"为空"两种),否则声明错类型也检不出来
 * (echo_status 的 additionalProperties:false 教训,见 index.js 的 statusShapes)。
 */
export const VOICE_RECEIPTS_FACE_SHAPE = Object.freeze({
  at: 0,
  total: 0,
  recent: [
    { kind: 'voice.external', session: 'sample', seq: 1, reason: null },
    { kind: 'voice.interrupted', session: 'sample', seq: null, reason: 'user-message' }
  ]
})

/** 回执里允许的 kind(契约枚举,别的一律丢)。 */
export const RECEIPT_KINDS = Object.freeze(['voice.external', 'voice.interrupted'])

/** 打断原因枚举(契约:user-message=barge-in / client-cancel=页面主动停 / browser-stop=页面静默)。 */
export const INTERRUPT_REASONS = Object.freeze(['user-message', 'client-cancel', 'browser-stop'])

const DDL = `
CREATE TABLE IF NOT EXISTS voice_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  session TEXT NOT NULL,
  at REAL NOT NULL,
  turn_id TEXT,
  seg_id INTEGER,
  seq INTEGER,
  character TEXT,
  style TEXT,
  style_fallback INTEGER,
  generation INTEGER,
  reason TEXT,
  last_external_seq INTEGER,
  external_seqs TEXT,
  dropped_seqs TEXT,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_receipts_session_at ON voice_receipts(session, at);
CREATE INDEX IF NOT EXISTS idx_voice_receipts_kind ON voice_receipts(kind);
`

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr = (v) => typeof v === 'string'
const numOrNull = (v) => (isNum(v) ? v : null)
const strOrNull = (v) => (isStr(v) && v !== '' ? v : null)

/** seq 数组 → JSON 字符串;非数组/含非数字一律当空数组(坏输入不值得为它拒整条)。 */
function seqListToJson (v) {
  if (!Array.isArray(v)) return '[]'
  const list = v.filter(isNum)
  return JSON.stringify(list)
}

function seqListFromJson (v) {
  try {
    const list = JSON.parse(String(v ?? '[]'))
    return Array.isArray(list) ? list.filter(isNum) : []
  } catch {
    return []
  }
}

/** 行(蛇形)→ 回执形状(驼峰,与契约同名字段)。 */
function rowToEntry (row) {
  return {
    kind: row.kind,
    session: row.session,
    at: row.at,
    turnId: row.turn_id ?? null,
    segId: row.seg_id ?? null,
    seq: row.seq ?? null,
    character: row.character ?? null,
    style: row.style ?? null,
    styleFallback: row.style_fallback === null ? null : row.style_fallback === 1,
    generation: row.generation ?? null,
    reason: row.reason ?? null,
    lastExternalSeq: row.last_external_seq ?? null,
    externalSeqs: seqListFromJson(row.external_seqs),
    droppedSeqs: seqListFromJson(row.dropped_seqs),
    createdAt: row.created_at
  }
}

/**
 * 校验并归一一条回执。返回落库参数,或 null = 这条是坏输入(调用方丢弃,不抛)。
 *
 * 必填:kind 枚举、session 非空串、at 毫秒数;
 *   voice.external 另需 seq(对账键,heart-tts 会话内自增);
 *   voice.interrupted 另需 reason(枚举)。
 * 其余字段按契约宽容收:缺了记 null,数组坏了记空 —— 但**必填缺一个就丢整条**
 * (半条回执比没有回执更容易把"她说到了第几句"记错)。
 */
function normalize (entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const kind = entry.kind
  if (!RECEIPT_KINDS.includes(kind)) return null
  const session = strOrNull(entry.session)
  if (session === null) return null
  if (!isNum(entry.at)) return null

  const base = {
    kind,
    session,
    at: entry.at,
    turnId: strOrNull(entry.turnId),
    segId: numOrNull(entry.segId),
    seq: null,
    character: strOrNull(entry.character),
    style: strOrNull(entry.style),
    styleFallback: (typeof entry.styleFallback === 'boolean' ? (entry.styleFallback ? 1 : 0) : null),
    generation: numOrNull(entry.generation),
    reason: null,
    lastExternalSeq: null,
    externalSeqs: '[]',
    droppedSeqs: '[]'
  }

  if (kind === 'voice.external') {
    if (!isNum(entry.seq)) return null
    base.seq = entry.seq
    return base
  }

  // voice.interrupted:reason 是痕的核心,缺了这条痕就没有意义
  const reason = strOrNull(entry.reason)
  if (reason === null || !INTERRUPT_REASONS.includes(reason)) return null
  base.reason = reason
  base.lastExternalSeq = numOrNull(entry.lastExternalSeq)
  base.externalSeqs = seqListToJson(entry.externalSeqs)
  base.droppedSeqs = seqListToJson(entry.droppedSeqs)
  return base
}

/**
 * 建账本。`db` 是 node:sqlite 的 DatabaseSync(由 store 持有,这里**只读写自己的表**);
 * 传 null = 库离线:receive 校验后只记日志丢弃,查询回空值 —— 照样绝不抛。
 */
export function createVoiceReceiptLedger (db, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const cap = isNum(opts.perSessionCap) && opts.perSessionCap > 0 ? Math.floor(opts.perSessionCap) : PER_SESSION_CAP
  const faceRecent = isNum(opts.faceRecent) && opts.faceRecent > 0 ? Math.floor(opts.faceRecent) : 5

  let ensured = false
  function ensureTable () {
    if (ensured || db === null || db === undefined) return ensured
    try {
      db.exec(DDL)
      ensured = true
    } catch (err) {
      log('建表失败(回执只记日志丢弃):' + String(err?.message ?? err))
    }
    return ensured
  }
  // 建账即建表(有库就建;坏输入丢弃也照样有表可查)。失败不抛,只记日志。
  ensureTable()

  function insert (b) {
    if (!ensureTable()) return false
    try {
      db.prepare(
        `INSERT INTO voice_receipts
           (kind, session, at, turn_id, seg_id, seq, character, style, style_fallback,
            generation, reason, last_external_seq, external_seqs, dropped_seqs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        b.kind, b.session, b.at, b.turnId, b.segId, b.seq, b.character, b.style, b.styleFallback,
        b.generation, b.reason, b.lastExternalSeq, b.externalSeqs, b.droppedSeqs, Date.now()
      )
      // 每会话滚动上限:超了删最旧(按 at, 同毫秒按 id —— 与查询同一口径)
      db.prepare(
        `DELETE FROM voice_receipts
          WHERE session = ?
            AND id NOT IN (SELECT id FROM voice_receipts WHERE session = ?
                           ORDER BY at DESC, id DESC LIMIT ?)`
      ).run(b.session, b.session, cap)
      return true
    } catch (err) {
      log('落库失败(session=' + b.session + ' kind=' + b.kind + '):' + String(err?.message ?? err))
      return false
    }
  }

  function all (sql, params) {
    if (!ensureTable()) return []
    try {
      return db.prepare(sql).all(...params).map(rowToEntry)
    } catch (err) {
      log('查询失败:' + String(err?.message ?? err))
      return []
    }
  }

  return {
    /**
     * 接收一条回执(heart-tts 软发现的钩子本体)。
     * 返回 true=已落账 / false=坏输入或落库失败(已丢弃并记日志)。
     * **任何情况都不抛** —— 抛错会被对端当契约违约弃用接收端。
     */
    receive (entry) {
      try {
        const b = normalize(entry)
        if (b === null) {
          log('丢弃非法回执(缺字段或 kind/reason 不在枚举):' + safePreview(entry))
          return false
        }
        return insert(b)
      } catch (err) {
        // 最后一道兜底:receive 是对外钩子,连"记日志"炸了也得吞掉
        try { log('回执处理异常(已吞):' + String(err?.message ?? err)) } catch { /* 日志也不行就认了 */ }
        return false
      }
    },

    /**
     * 该会话最后已外化的 seq(可撤边界)。取 voice.external 的 **MAX(seq)**
     * (heart-tts 的 seq 会话内单调,MAX=最后);没有 external 行时退回最近
     * 一条打断痕的 lastExternalSeq(痕里也记着"外化到第几句")。查不到 = null。
     */
    getLastExternalSeq (session) {
      try {
        const sid = strOrNull(session)
        if (sid === null) return null
        if (!ensureTable()) return null
        const r1 = db.prepare(
          "SELECT MAX(seq) AS m FROM voice_receipts WHERE session = ? AND kind = 'voice.external'"
        ).get(sid)
        if (r1?.m !== null && r1?.m !== undefined) return r1.m
        const r2 = db.prepare(
          "SELECT MAX(last_external_seq) AS m FROM voice_receipts WHERE session = ? AND kind = 'voice.interrupted'"
        ).get(sid)
        return (r2?.m ?? null)
      } catch (err) {
        log('getLastExternalSeq 失败:' + String(err?.message ?? err))
        return null
      }
    },

    /** 最近 N 条打断痕,时间倒序(at 同毫秒按 id 倒)。 */
    getRecentInterrupts (session, limit = 10) {
      const sid = strOrNull(session)
      if (sid === null) return []
      const n = isNum(limit) && limit > 0 ? Math.floor(limit) : 10
      return all(
        "SELECT * FROM voice_receipts WHERE session = ? AND kind = 'voice.interrupted' ORDER BY at DESC, id DESC LIMIT ?",
        [sid, n]
      )
    },

    /** 该会话原始回执列表(两类都在),时间倒序。 */
    getReceiptsBySession (session, limit = 50) {
      const sid = strOrNull(session)
      if (sid === null) return []
      const n = isNum(limit) && limit > 0 ? Math.floor(limit) : 50
      return all(
        'SELECT * FROM voice_receipts WHERE session = ? ORDER BY at DESC, id DESC LIMIT ?',
        [sid, n]
      )
    },

    /**
     * 最近用过的 style(含静默回落标志)—— 给"她语气不对"排查用。
     * 只看 voice.external(style 是外化那一刻服务端回显的实际样式),时间倒序。
     */
    getStyleHistory (session, limit = 20) {
      const sid = strOrNull(session)
      if (sid === null) return []
      const n = isNum(limit) && limit > 0 ? Math.floor(limit) : 20
      if (!ensureTable()) return []
      try {
        return db.prepare(
          "SELECT seq, style, style_fallback, at FROM voice_receipts WHERE session = ? AND kind = 'voice.external' ORDER BY at DESC, id DESC LIMIT ?"
        ).all(sid, n).map((r) => ({
          seq: r.seq ?? null,
          style: r.style ?? null,
          styleFallback: r.style_fallback === null ? null : r.style_fallback === 1,
          at: r.at
        }))
      } catch (err) {
        log('getStyleHistory 失败:' + String(err?.message ?? err))
        return []
      }
    },

    /**
     * echo_status 状态面摘要:最近 N 条(kind/session/seq/reason)——
     * **不含对话正文**,面板/工具随便展示。
     */
    statusFace () {
      try {
        if (!ensureTable()) return { ...VOICE_RECEIPTS_FACE_SHAPE }
        const total = db.prepare('SELECT COUNT(*) AS n FROM voice_receipts').get()?.n ?? 0
        const rows = db.prepare(
          'SELECT kind, session, seq, reason FROM voice_receipts ORDER BY at DESC, id DESC LIMIT ?'
        ).all(faceRecent)
        return {
          at: Date.now(),
          total,
          recent: rows.map((r) => ({
            kind: r.kind,
            session: r.session,
            seq: r.seq ?? null,
            reason: r.reason ?? null
          }))
        }
      } catch (err) {
        try { log('statusFace 失败:' + String(err?.message ?? err)) } catch { /* 吞 */ }
        return null
      }
    },

    /** 账本自报(调试):表在不在、上限多少。 */
    describe () {
      return { table: 'voice_receipts', perSessionCap: cap, online: db !== null && db !== undefined }
    }
  }
}

/** 坏输入预览(只取 kind/session/seq 三个安全字段,绝不把正文拼进日志)。 */
function safePreview (entry) {
  try {
    if (entry === null || typeof entry !== 'object') return typeof entry
    return 'kind=' + String(entry.kind) + ' session=' + String(entry.session) + ' seq=' + String(entry.seq)
  } catch {
    return '(uninspectable)'
  }
}
