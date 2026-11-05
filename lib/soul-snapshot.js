/**
 * v0.20.0 D1:soul 只读快照(策展块的原料)。
 *
 * 为什么单独一个文件:它只依赖 `node:sqlite`,**不碰宿主包** ⇒ 能拿真库
 * 离线测。这张电池很值:列名写错是这项目的老坑(我自己就在
 * `episodic_memory` 上把 `created_at` 当成了真列,实际是
 * `timestamp/occurred_at/learned_at`)。
 *
 * 纪律:
 *   - **只读**打开(readOnly),绝不写 soul 库 —— 写是 lib/index.js 的事;
 *   - 一次连接、几发查询、立刻关(压缩很稀有,不值得常驻句柄,也就永远
 *     不会跟主连接抢锁);
 *   - 单条查询失败就退化成空(宁可少写一段,也不能让压缩整条失败);
 *   - 表/库不存在 ⇒ 返回 {} ⇒ 调用方走 fallbackText()。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
// P2 期间落 P1 尾巴(2026-10-05):库路径不再自己拼,统一走 data-dir 的唯一解析。
import { resolveDbPath } from './data-dir.js'

/** 库路径:与 lib/index.js 同一套解析(DSH_HOME/echo/echo.db,允许 ECHO_DB 覆盖)。 */
export function dbPathOf () {
  return resolveDbPath()
}

/**
 * 类内时效(秒):promise 14 天 / care 3 天 / topic 30 天。
 * `schedule` / `reminder` **不设年龄** —— 它们有绝对时间,由 D2 的冷却接管
 * (事件过后 6h / 12h 就冷却,过时即不再进 prompt)。
 * ⚠️ 与 `python/engine/threads.py:COOL_AFTER_SECONDS` **同源**,
 * `tests/thread-kinds.test.js` 会从那边抠出来逐条比对。
 */
export const THREAD_KIND_MAX_AGE_SEC = {
  promise: 14 * 86400,
  care: 3 * 86400,
  topic: 30 * 86400
}

/**
 * 注入配额(每类最多占几个席位;没列到的类不限)。
 * 挡的是"同一类霸屏" —— 实测行程类一次占满一屏(设计 §5.3)。
 */
export const THREAD_KIND_CAPS = { topic: 2, schedule: 2, care: 1 }

/**
 * 按类配额筛一遍(纯函数:保持原顺序,超配额的同 kind 行丢掉)。
 * @param {Array<object>} rows 已排序的候选行(每行带 `kind`)
 * @param {Record<string, number>} [caps]
 * @returns {Array<object>} 新数组(不改入参)
 */
export function capThreadsByKind (rows, caps = THREAD_KIND_CAPS) {
  const list = Array.isArray(rows) ? rows : []
  const used = new Map()
  const out = []
  for (const row of list) {
    const kind = String((row && row.kind) || '')
    const hasCap = Object.prototype.hasOwnProperty.call(caps, kind)
    if (hasCap) {
      const cap = Number(caps[kind])
      const n = used.get(kind) || 0
      if (Number.isFinite(cap) && n >= cap) continue
      used.set(kind, n + 1)
    }
    out.push(row)
  }
  return out
}

export function readSoulSnapshot (dbPath = dbPathOf(), now = Math.floor(Date.now() / 1000)) {
  if (String(dbPath) !== ':memory:' && !existsSync(dbPath)) return {}
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const one = (sql, ...args) => {
      try { return db.prepare(sql).get(...args) ?? null } catch { return null }
    }
    const many = (sql, ...args) => {
      try { return db.prepare(sql).all(...args) } catch { return [] }
    }
    const profile = one('SELECT user_id, name, core_traits, affinity FROM user_profile WHERE user_id = ?', 'master')
    const memories = one('SELECT COUNT(*) c FROM episodic_memory WHERE is_active = 1')
    const beliefs = one("SELECT COUNT(*) c FROM graph_nodes WHERE is_active = 1 AND node_type = 'belief'")
    const turns = one('SELECT COUNT(*) c, MIN(created_at) f, MAX(created_at) l FROM conversation_log')
    // 2026-10-06 D3(设计 §5.1/§5.3):注入侧三条与门 —— **活跃 × 有类别 × 类内时效**。
    //  · 活跃:`cooling_at=0 AND archived_at=0`(冷却/归档由 D2 的 tick 盖列)
    //  · 有类别:`kind <> ''` —— 未分类**一律不进**(判不出类型就别占席位)
    //  · 类内时效:promise/care/topic 按创建时刻;schedule/reminder 交给冷却
    // 排序第三键 `created_at` → **`updated_at`**:"最近动过"比"新建"更接近活跃
    // (老口径只奖励新,不奖励重要)。
    // ⚠️ 这是影子期之后**第一次由读出侧引用 D1/D2 的新列**。
    const threads = many("SELECT content, follow_up_after, created_at, updated_at, kind,"
      + " last_mentioned_at FROM pending_threads"
      + " WHERE status = 'open' AND COALESCE(cooling_at, 0) = 0 AND COALESCE(archived_at, 0) = 0"
      + "   AND kind <> ''"
      + "   AND (kind IN ('schedule', 'reminder')"
      + "        OR (kind = 'promise' AND created_at > ?)"
      + "        OR (kind = 'care' AND created_at > ?)"
      + "        OR (kind = 'topic' AND created_at > ?))"
      + " ORDER BY (follow_up_after > 0) DESC, follow_up_after ASC, updated_at DESC LIMIT 8",
      now - THREAD_KIND_MAX_AGE_SEC.promise,
      now - THREAD_KIND_MAX_AGE_SEC.care,
      now - THREAD_KIND_MAX_AGE_SEC.topic)
    // 最该活下来的:内在价值 + 情绪强度,时间做次级键(不让陈年旧账霸榜)
    const moments = many('SELECT summary, timestamp, emotion_score, intrinsic_value FROM episodic_memory'
      + " WHERE is_active = 1 AND summary IS NOT NULL AND summary != ''"
      + ' ORDER BY (COALESCE(intrinsic_value, 0) + COALESCE(emotion_score, 0) * 0.5) DESC, timestamp DESC LIMIT 10')
    const mood = one('SELECT mood_intensity, user_emotion, mood_reason, updated_at FROM agent_state'
      + ' WHERE updated_at > 0 ORDER BY updated_at DESC LIMIT 1')
    return {
      profile,
      counts: {
        memories: Number(memories?.c) || 0,
        beliefs: Number(beliefs?.c) || 0,
        turns: Number(turns?.c) || 0,
        firstAt: Number(turns?.f) || 0,
        lastAt: Number(turns?.l) || 0
      },
      threads: capThreadsByKind(threads.map((t) => ({
        content: t.content,
        follow_up_after: t.follow_up_after,
        created_at: t.created_at,
        updated_at: t.updated_at,
        kind: t.kind,
        last_mentioned_at: t.last_mentioned_at
      }))),
      moments: moments.map((m) => ({ summary: m.summary, timestamp: m.timestamp, emotion_score: m.emotion_score })),
      mood,
      now
    }
  } finally {
    try { db.close() } catch { }
  }
}

/** 兜底一页:连库都读不到时也要给引擎一段**非空**文本(空摘要会硬抛)。 */
export function fallbackText () {
  return '【她自己的记忆库策展 · 压缩备忘】\n'
    + '── 账本: 这一轮压缩时她的记忆库没读到(库不在或被锁)。\n'
    + '(以下是背景,不是他此刻说的话;别复述本段,也别提"压缩"或"备忘"。)'
}
